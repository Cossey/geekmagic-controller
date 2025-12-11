 - Device-level polling: Each device can specify a `polling` value (seconds) in its configuration. If `polling` is 0, polling is disabled for that device. The app still loads the initial state for the device at startup. When omitted, the default poll interval is `verify.pollIntervalSeconds` or 30 seconds.
# Copilot / AI Agent Instructions for GeekMagic Controller

Purpose: This repo implements an MQTT-to-HTTP command bridge for 'smalltv-ultra' devices. The controller listens on an MQTT broker and converts topic messages into HTTP GET requests to device hostnames (IP or DNS).

Key files and responsibilities:
- `config.yaml` — YAML config: devices array + mqtt settings.
- `src/config.ts` — Loads and validates config.
- `src/mqttClient.ts` — Connects to MQTT, subscribes to `${basetopic}/#`, parses topics, and delegates to `DeviceController`.
- `src/deviceController.ts` — Validates device names, maps commands (THEME, BRIGHTNESS, REBOOT) to HTTP query parameters (e.g. `?theme=3`), and triggers `sendGet`.
- `src/httpClient.ts` — Thin wrapper around axios for GET requests with timeout and error handling.
- `src/index.ts` — CLI entrypoint. Starts the controller and handles shutdown.

Patterns and conventions the agent should follow:
 - Config-driven: devices are keyed by `name` in YAML and must match the MQTT subtopic.
	 The project now accepts two forms for `devices` in the YAML config:
	 - Array form (legacy):

	   ```yaml
	   devices:
		   - name: lounge-tv
			   type: smalltv-ultra
			   host: 192.168.1.50
	   ```

	 - Mapping form (recommended):

	   ```yaml
	   devices:
		   lounge-tv:
			   type: smalltv-ultra
			   host: 192.168.1.50
	   ```

		The device name in the MQTT topic must match the device identifier in YAML (e.g. `gm/lounge-tv/THEME`).
		- The device configuration uses `host` (IP or hostname).
- Commands are case-insensitive but code uses uppercase. Use `command.toUpperCase()` before matching.
- Numeric validation: `THEME` and `BRIGHTNESS` must parse to numbers; otherwise ignore and log a warning.
	- HTTP mapping: root URL is `http://<deviceHost>/set`. THEME -> `?theme=`, BRIGHTNESS -> `?brt=`, COMMAND -> `?reboot=1`.

	 - MQTT State topics: the controller publishes device state values to retained topics using the `<basetopic>/<deviceName>/BRIGHTNESS` and `<basetopic>/<deviceName>/THEME` topics. Commands are only accepted on `<basetopic>/<deviceName>/BRIGHTNESS/SET` and `<basetopic>/<deviceName>/THEME/SET`, or `<basetopic>/<deviceName>/COMMAND`.
- Errors: When a device doesn't exist or an unsupported command arrives, log and ignore; do not crash the service.
- Tests: Add a unit test whenever you add or change command mappings; test URL building and payload validation.

State & verification:
- The repo supports verifying state after sending a command as well as background polling to load initial device state and keep a cache.
- Config options are in the `verify` section in `config.yaml`:
	- `afterCommand`: boolean to enable immediate verification after a set command.
	- `retries`: number of verification retry attempts.
	- `initialDelayMs`, `backoffMs`: timings between retries.
	- `pollIntervalSeconds`: interval for background polling to refresh device state.
- Files to update for verification/polling behavior: `src/deviceController.ts` (verifyCommand, loadStateForAllDevices, startStatePolling), `src/httpClient.ts` (getJson helper).
 - Files to update for verification/polling behavior: `src/deviceController.ts` (verifyCommand, loadStateForAllDevices, startStatePolling, getState), `src/httpClient.ts` (getJson helper).

Common `DeviceController` methods:
- `verifyCommand(device, command, expected)` — on-demand verification by querying JSON file(s).
- `loadDeviceState(device)` — fetch `brt.json` and `app.json` to refresh device state cache.
- `loadStateForAllDevices()` — initial load and on-demand refresh for all devices.
- `startStatePolling(intervalSeconds)` — start a background poller; `stopStatePolling()` to stop.
- `getState(deviceName)` — returns the cached state (brt, theme).
- When adding support, add tests in `src/__tests__/deviceController.verify.test.ts` (for on-demand verification) and `src/__tests__/deviceController.state.test.ts` (for polling/state load).

Developer workflows:
- Install: `npm install`
- Dev server: `npm run dev -- config.yaml` (uses `ts-node-dev`)
- Build for production: `npm run build` then `npm run start`
- Test: `npm test`

Integration & testing tips:
- Use `mosquitto_pub` to simulate MQTT messages during dev.
- Mock HTTP requests using `nock` in unit tests when adding end-to-end tests.
- Keep DeviceController focused on mapping logic; keep MQTT parsing in `MqttService`.

When extending the codebase:
- If adding a new device type or command, update `DeviceController.buildCommandUrl` and add tests.
- If adding new config keys, update `src/config.ts` to validate and the README with examples.
- Keep log messages useful and small; use `src/logger.ts` helpers.

If unsure about a change, add a minimal failing unit test first, and make the implementation to satisfy it.
