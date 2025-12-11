# GeekMagic Controller

Lightweight MQTT-to-HTTP bridge for `smalltv-ultra` devices. Loads YAML configuration, subscribes to an MQTT broker, and forwards certain device commands as HTTP GET requests.

Quick start:
- Install dependencies: `npm install`
- Run in development: `npm run dev -- config.yaml`
- Build: `npm run build` and run: `npm run start`
- Test: `npm test`

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



 - `<basetopic>/<deviceName>/BRIGHTNESS` – value is 0-100
 - `<basetopic>/<deviceName>/THEME` – value is 1-7
 - `<basetopic>/<deviceName>/COLONBLINK` – value is YES/NO (device value 1/0)
 - `<basetopic>/<deviceName>/12HOUR` – value is YES/NO (device value 1/0)
 - `<basetopic>/<deviceName>/DST` – value is YES/NO (device value 1/0)

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
