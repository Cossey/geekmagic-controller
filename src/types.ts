export type Device = {
  name: string;
  type: string;
  // `host` can be an IP address or a DNS name. Accept either IPv4/IPv6 or hostnames.
  host: string;
  // `polling` controls per-device polling interval in seconds. If 0, polling for the device is disabled.
  // Defaults to the global `verify.pollIntervalSeconds` or 30 if not set.
  polling?: number;
};

export type MQTTConfig = {
  server: string;
  port: number;
  basetopic: string;
  user?: string;
  password?: string;
  client?: string;
};

export type VerifyConfig = {
  afterCommand?: boolean; // verify immediately after sending the HTTP set
  retries?: number;
  initialDelayMs?: number;
  backoffMs?: number;
  pollIntervalSeconds?: number; // optional background poll interval
};

export type ConfigSchema = {
  devices: Device[];
  mqtt: MQTTConfig;
  verify?: VerifyConfig;
};

// A function DeviceController can call to publish device state to MQTT.
// deviceName - the device identifier
// state - partial state object with brt and/or theme
// retain - whether the message should be retained by the broker (default true)
export type MqttPublishFn = (
  deviceName: string,
  state: { brt?: number; theme?: number; colon?: number; hour12?: number; dst?: number },
  retain?: boolean
) => Promise<void>;
