# GeekMagic Controller

Lightweight MQTT-to-HTTP bridge for `smalltv-ultra` devices. Loads YAML configuration, subscribes to an MQTT broker, and forwards certain device commands as HTTP GET requests.

Quick start:

- Install dependencies: `npm install`
- Run in development: `npm run dev -- config.yaml`
- Build: `npm run build` and run: `npm run start`
- Test: `npm test`

## Fonts & Docker

When running in a minimal Linux container (for example `node:alpine`), SVG text rendering can show 'tofu' (empty squares) if system fonts are not available. If you see squares where text should be when using the `IMAGE/GENERATE` feature inside Docker, ensure the runtime container includes fontconfig and at least one TrueType font like DejaVu.

For the official Docker image included in this repo, the runtime stage installs `fontconfig` and `ttf-dejavu` and runs `fc-cache` so Sharp can render text correctly. If you build your own image or use another base, ensure you install these packages and update font cache, for example:

```sh
apk add --no-cache fontconfig ttf-dejavu ttf-freefont
fc-cache -f -v
```

If you need additional language support (e.g., Chinese/Japanese/Korean), include a CJK font such as Noto CJK fonts in your image.

The YAML structure is shown in `config.yaml`. The repo accepts two forms for `devices`:

- Array form (existing style):

```yaml
devices:
  - name: lounge-tv
    type: smalltv-ultra
    host: 192.168.1.50
```

- Mapping form (preferred):

```yaml
devices:
  lounge-tv:
    type: smalltv-ultra
    host: 192.168.1.50
```

Notes:

- The `host` property accepts either an IP address or a hostname (DNS).

## Verify & State Polling

- This project supports verifying state after issuing a command, and a background poller that loads state on startup and periodically refreshes.
- The optional `verify` section in `config.yaml` controls these features (example in `config.yaml`):

```yaml
verify:
  afterCommand: true
  retries: 3
  initialDelayMs: 300
  backoffMs: 200
  pollIntervalSeconds: 30
```

- `afterCommand` enables automatic verification by reading `brt.json` or `app.json` after setting values.
- `pollIntervalSeconds` (default 30s) configures background polling to refresh device state every N seconds. On startup the controller will fetch all device state once, then start polling.

### Polling behavior and published state topics

On the initial connect and on every polling cycle the controller fetches the device state and republishes the retained MQTT state topics for the key values it knows about. Specifically it will publish (if present):

- `<basetopic>/<device>/BRIGHTNESS` (0-100)
- `<basetopic>/<device>/THEME` (1-7)
- `<basetopic>/<device>/COLONBLINK` (YES/NO)
- `<basetopic>/<device>/12HOUR` (YES/NO)
- `<basetopic>/<device>/DST` (YES/NO)

This ensures that after connecting (or while polling) the retained MQTT topics reflect the device's current state.



## MQTT Topics and usage

The controller supports two patterns for sending commands:

- Preferred: publish to `<basetopic>/<deviceName>/<ITEM>/SET` with the payload containing the value. Examples:
  - `mosquitto_pub -h 127.0.0.1 -t gm/lounge-tv/BRIGHTNESS/SET -m '75'`
  - `mosquitto_pub -h 127.0.0.1 -t gm/lounge-tv/THEME/SET -m '3'`
  - `mosquitto_pub -h 127.0.0.1 -t gm/lounge-tv/COMMAND -m 'REBOOT'`
  - `mosquitto_pub -h 127.0.0.1 -t gm/lounge-tv/COLONBLINK/SET -m 'YES'`
  - `mosquitto_pub -h 127.0.0.1 -t gm/lounge-tv/12HOUR/SET -m 'NO'`
  - `mosquitto_pub -h 127.0.0.1 -t gm/lounge-tv/DST/SET -m 'YES'`
  - `mosquitto_pub -h 127.0.0.1 -t gm/lounge-tv/IMAGE/SET -m '<data-uri-or-base64>'`

  The `device/<ITEM>/SET` payload accepts a plain value, e.g. `75`, or JSON like `{"value":75}`.

-- Legacy per-command topics have been removed. Only the `device/<ITEM>/SET` and `device/COMMAND` patterns are supported.





For boolean flags (COLONBLINK, 12HOUR, DST):

- Publishing: these state topics will be published as the strings `YES` for 1 and `NO` for 0 to abstract the underlying numeric values.
- Set (command): you can send a SET payload as any of the following and it will be normalized to 0/1 for the device: `YES`/`NO`, `1`/`0`, `true`/`false`, `ON`/`OFF`.

IMAGE uploads

- Publish to `<basetopic>/<deviceName>/IMAGE/SET` with the payload set to a data URI (e.g. `data:image/png;base64,...`) or a raw base64 string of the image.
- The controller will process the image and ensure the final uploaded image is exactly 240x240 pixels.
- If the incoming image is larger than 240x240, the per-device image config (see below) controls whether the image is cropped or resized.
- After a successful upload the controller will set `THEME` to `3` on the device automatically.

Supported upload formats and behavior

- The device accepts JPG/JPEG and GIF uploads. If an input image is not in a supported format (for example, PNG), the controller will convert it to JPG before uploading.
- If the input is a GIF and is already exactly 240x240, the controller will upload it as a GIF and preserve the GIF (no conversion). If the GIF is not the right size it will be converted to JPG.
- If the input is a GIF and is already exactly 240x240, the controller will upload it as a GIF and preserve the GIF (no conversion). If the GIF is not 240x240 the controller will resize/crop it to 240x240 and upload an animated GIF (animation is preserved when possible).
- Upload endpoint: the controller uploads images via multipart/form-data to `http://<device.host>/doUpload?dir=/image/` using a single form field named `image`.
- The uploaded filename is always `upload.<ext>` (for example `upload.jpg` or `upload.gif`) so that the device can overwrite the same file each time and conserve storage.
- After setting the theme to `3` the controller also instructs the device to select the uploaded file by calling:

  `http://<device.host>/set?img=%2Fimage%2F%2Fupload.<ext>`

  where `<ext>` is the actual file extension used (jpg or gif).

Device image configuration (per-device)

Add an `image` block under each device in `config.yaml` to control oversize behaviour and crop position. Example:

```yaml
devices:
  lounge-tv:
    type: smalltv-ultra
    host: 192.168.1.50
    image:
      oversize: crop        # crop | resize  (default: resize)
      cropposition: topright # top|left|bottom|right|topleft|topright|bottomleft|bottomright|center (default: center)
```

When `oversize: crop` the controller will extract a 240x240 section from the incoming image based on `cropposition` (for example `topright` will select the 240x240 square from the top-right corner). When `oversize: resize` the controller will scale the image to fit within a 240x240 box and pad as needed to produce an exact 240x240 final image.

Note on device upload quirks:

- Some device firmwares return an HTTP error message like "Duplicate content length" even though the upload actually succeeds. The controller treats that specific error as a successful upload and proceeds to select the image and set the theme.

Compatibility note for selecting uploaded images

- The controller tries multiple variants when instructing the device to select the uploaded image (for example encoded vs unencoded paths, `/image//upload.jpg` vs `/image/upload.jpg`, etc). By default the controller now attempts to select the image first and then set `THEME=3` (this order works better on most devices). If that doesn't succeed it falls back to trying `THEME=3` first then selecting the image. If needed you can tune the small delays and retry counts per-device using the `image.selection*` options shown above.

### IMAGE/GENERATE — generate images from text/markup

You can programmatically generate a 240×240 image and upload it to the device by publishing to the topic:

```text
<basetopic>/<deviceName>/IMAGE/GENERATE
```

Payloads supported:

- Plain string: treated as the text to render.
- JSON object: `{ "text": "...", "background": "#000000", "textColor": "#ffffff", "fontSize": 28, "halign": "left|center|right", "valign": "top|center|bottom" }` (all fields optional)
 - JSON object: `{ "text": "...", "background": "#000000", "textColor": "#ffffff", "fontSize": 28, "halign": "left|center|right", "valign": "top|center|bottom", "hmargin": 0, "vmargin": 0 }` (all fields optional)

Markup supported in the `text` string:

- `[color=#rrggbb]...[/color]` — set a hex color for the enclosed text (eg. `#ff0000`).
- `[b]...[/b]` — bold text.
- `[i]...[/i]` — italic text.
- `[img:data-uri]` — inline image using a data URI (for example `data:image/png;base64,...`). Inline images are centered and rendered at ~96×96.
- Use `\n` (or real line breaks in JSON strings) to create new lines.

- `halign` - Horizontal alignment for text and inline images (default `center`). Values: `left`, `center`, `right`.
- `valign` - Vertical alignment within the 240×240 image (default `center`). Values: `top`, `center`, `bottom`.
 - `hmargin` - Optional integer (pixels) specifying the horizontal margin relative to the chosen `halign` anchor. When `halign=left`, this is the number of pixels from the left edge; when `halign=right`, this is the number of pixels from the right edge; when `halign=center`, this is a pixel offset from the image center (positive moves right).
 - `vmargin` - Optional integer (pixels) specifying the vertical margin relative to the chosen `valign` anchor. When `valign=top`, this is the number of pixels from the top edge; when `valign=bottom`, this is the number of pixels from the bottom edge; when `valign=center`, this is a pixel offset from the vertical center (positive moves down).

- Multiple spaces are preserved in generated text (the renderer sets xml:space="preserve" so `A  B` keeps two spaces).

Behavior and defaults:

- Final image is rendered to 240×240 pixels and uploaded as `upload.jpg` to `http://<device>/doUpload?dir=/image/`.
- The controller sets the device `THEME` to `3` and issues a `set?img=...` to select the uploaded image.
- Default background: `#000000` (black). Default text color: `#ffffff` (white). Default font size: `28` (the renderer will shrink the font to fit if necessary down to a small minimum).
- Only a simple markup language is supported (no HTML/CSS); nesting is supported in simple cases (bold/italic inside color blocks), but complex nesting or layout is not guaranteed.

Progress/status via MQTT:

- While generating, uploading, and selecting images the controller publishes status updates to the retained topic:

  ```text
  <basetopic>/<deviceName>/IMAGE/STATUS
  ```

  Each message is a small JSON string containing a `stage` field. Common stages emitted are `rendering`, `uploading`, `uploaded`, `selecting`, `done`, and `error`. The `done` payload will include `themeOk` and `imgSelected` booleans and may include `themeUrl` and `imgUrl` (the exact `set` URLs that succeeded) to aid remote debugging.

Examples (Unix shell):

```bash
mosquitto_pub -h 127.0.0.1 -t gm/lounge-tv/IMAGE/GENERATE -m 'Hello World'

mosquitto_pub -h 127.0.0.1 -t gm/lounge-tv/IMAGE/GENERATE -m '{"text":"Line1\n[color=#ff0000][b]Red[/b][/color]" , "background":"#000000", "textColor":"#ffffff", "fontSize":28}'
```

Examples (PowerShell):

```powershell
mosquitto_pub -h 127.0.0.1 -t gm/lounge-tv/IMAGE/GENERATE -m '{"text":"Line1\n[img:data:image/png;base64,....]"}'
```

Example with left/top alignment:

```powershell
mosquitto_pub -h 127.0.0.1 -t gm/lounge-tv/IMAGE/GENERATE -m '{"text":"Left aligned", "halign":"left", "valign":"top"}'
```

Example with left/top alignment and margins:

```bash
mosquitto_pub -h 127.0.0.1 -t gm/lounge-tv/IMAGE/GENERATE -m '{"text":"Left aligned", "halign":"left", "valign":"top", "hmargin":12, "vmargin":8 }'
```

Example with center alignment and offsets:

```bash
mosquitto_pub -h 127.0.0.1 -t gm/lounge-tv/IMAGE/GENERATE -m '{"text":"Centered with offset", "halign":"center", "valign":"center", "hmargin":10, "vmargin":15 }'
```

Tip: if sending large data URIs inside MQTT messages, consider using a JSON payload and single-quoting the whole message on shells that support it so you don't need to escape inner double quotes.

### Controller status topic (LWT)

The controller publishes a retained LWT status message to `<basetopic>/STATUS` (default `gm/STATUS`). The message is:

- `ONLINE` (retained) — published by the controller when it successfully connects to the broker.
- `OFFLINE` (retained) — published by the broker if the controller disconnects unexpectedly (LWT), and also published by the controller on graceful shutdown.

This topic is useful for monitoring and for tools and automations which need to know whether the controller is currently connected to the MQTT broker.

See `src/deviceController.ts` → `generateAndUploadImage` for the exact implementation details if you need to understand parsing/limitations.

State topics are read-only. Sending commands is only supported on the SET subtopic, e.g. `gm/<device>/BRIGHTNESS/SET` or `gm/<device>/THEME/SET`.

## Docker

Build a production image:

```bash
docker build -t gm-controller:latest .
```

Run with a mapped config folder (recommended):

```bash
docker run --rm -v /path/to/config:/config gm-controller:latest
```

When the container starts it will check `/config/config.yaml` (this is the default argument). Map your host folder containing the file into `/config` in the container so it can be configured at runtime. If you mount a config folder, ensure `config.yaml` exists in that host folder.


The YAML structure is shown in `config.yaml`.

## Secrets & Environment variables

For secure deployments, you should avoid embedding credentials in `config.yaml` when possible. The controller supports two environment-based ways to provide the MQTT password:

- `MQTT_PASSWORD_FILE` — the path to a file that contains the MQTT password. This is useful for Docker secrets or mounted files. If the file does not exist the application will fail to start with an explicit error.
- `MQTT_PASSWORD` — a plain environment variable containing the MQTT password.

Precedence (higher to lower): `MQTT_PASSWORD_FILE` > `MQTT_PASSWORD` > the `mqtt.password` field in `config.yaml`.

Examples:

Use an environment variable:

```bash
docker run --rm -v /path/to/config:/config -e MQTT_PASSWORD=super-secret gm-controller:latest
```

Use a secret file (bind-mounted or Docker secret):

```bash
docker run --rm \
  -v /path/to/config:/config \
  -v /path/to/mqtt_password:/run/secrets/mqtt_password \
  -e MQTT_PASSWORD_FILE=/run/secrets/mqtt_password \
  gm-controller:latest
```

With Docker Compose (example):

```yaml
version: '3.7'
services:
  gm-controller:
    image: gm-controller:latest
    volumes:
      - ./config:/config
    secrets:
      - mqtt_password
    environment:
      - MQTT_PASSWORD_FILE=/run/secrets/mqtt_password

secrets:
  mqtt_password:
    file: ./mqtt_password
```

Note: `MQTT_PASSWORD_FILE` is preferred for security reasons since the file contents are not visible in process environment or Docker inspect output.


 
## AI Assistance

Vibe coded by Raptor mini (Preview), with human "assistance".
