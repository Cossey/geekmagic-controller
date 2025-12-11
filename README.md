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



## MQTT Topics and usage

The controller supports two patterns for sending commands:

- Preferred: publish to `<basetopic>/<deviceName>/<ITEM>/SET` with the payload containing the value. Examples:
  - `mosquitto_pub -h 127.0.0.1 -t gm/lounge-tv/BRIGHTNESS/SET -m '75'`
  - `mosquitto_pub -h 127.0.0.1 -t gm/lounge-tv/THEME/SET -m '3'`
  - `mosquitto_pub -h 127.0.0.1 -t gm/lounge-tv/COMMAND -m 'REBOOT'`
  - `mosquitto_pub -h 127.0.0.1 -t gm/lounge-tv/COLONBLINK/SET -m 'YES'`
  - `mosquitto_pub -h 127.0.0.1 -t gm/lounge-tv/12HOUR/SET -m 'NO'`
  - `mosquitto_pub -h 127.0.0.1 -t gm/lounge-tv/DST/SET -m 'YES'`

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
