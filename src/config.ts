import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { ConfigSchema, Device } from './types';

export function loadConfig(filePath?: string): ConfigSchema {
  const configPath = filePath || path.resolve(process.cwd(), 'config.yaml');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = YAML.parse(raw);
  // Minimal validation
  if (!parsed || !parsed.mqtt) {
    throw new Error('Invalid configuration: mqtt section missing');
  }
  if (!parsed.devices) {
    throw new Error('Invalid configuration: devices missing');
  }

  // Normalize devices configuration to Device[] regardless of input shape
  let devices: Device[] = [];
  if (Array.isArray(parsed.devices)) {
    // validate array shape (each item must have a name, host, type)
  devices = parsed.devices.map((d: any) => {
  const hostVal = d?.host;
  const pollingVal = d?.polling !== undefined ? Number(d.polling) : undefined;
      if (!d || !d.name || !hostVal || !d.type) {
        throw new Error('Invalid devices array: each device must include name, type, and host');
      }
      if (pollingVal !== undefined && (!Number.isFinite(pollingVal) || Number(pollingVal) < 0)) {
        throw new Error('Invalid devices array: polling must be a non-negative number');
      }
      // Preserve image-related config when present
      let imageCfg = d.image !== undefined ? d.image : undefined;
      if (imageCfg) {
        // Ensure flip vertical/horizontal are booleans when present
        if (imageCfg.flip) {
          imageCfg.flip.vertical = imageCfg.flip.vertical === true;
          imageCfg.flip.horizontal = imageCfg.flip.horizontal === true;
        }
        // Normalize rotation to one of allowed values
        if (imageCfg.rotate !== undefined) {
          const r = Number(imageCfg.rotate);
          const allowed = [0, 90, 180, 270];
          imageCfg.rotate = allowed.includes(r) ? r : 0;
        }
      }
      return { name: d.name, type: d.type, host: hostVal, polling: pollingVal !== undefined ? Number(pollingVal) : undefined, image: imageCfg } as Device;
    });
  } else if (typeof parsed.devices === 'object') {
    // Map keyed object: { "lounge-tv": { type: 'smalltv-ultra', host: '1.2.3.4' } }
  devices = Object.entries(parsed.devices).map(([name, value]: [string, any]) => {
  const hostVal = value?.host;
  const pollingVal = value?.polling !== undefined ? Number(value.polling) : undefined;
      if (!value || !hostVal || !value.type) {
        throw new Error(`Invalid devices mapping: device ${name} must include type and host`);
      }
      if (pollingVal !== undefined && (!Number.isFinite(pollingVal) || Number(pollingVal) < 0)) {
        throw new Error(`Invalid devices mapping: device ${name} polling must be a non-negative number`);
      }
      // Preserve image block from mapping form as well
      let imageCfg = value.image !== undefined ? value.image : undefined;
      if (imageCfg) {
        if (imageCfg.flip) {
          imageCfg.flip.vertical = imageCfg.flip.vertical === true;
          imageCfg.flip.horizontal = imageCfg.flip.horizontal === true;
        }
        if (imageCfg.rotate !== undefined) {
          const r = Number(imageCfg.rotate);
          const allowed = [0, 90, 180, 270];
          imageCfg.rotate = allowed.includes(r) ? r : 0;
        }
      }
      return { name, type: value.type, host: hostVal, polling: pollingVal !== undefined ? Number(pollingVal) : undefined, image: imageCfg } as Device;
    });
  } else {
    throw new Error('Invalid configuration: devices must be an array or mapping');
  }

  // Detect duplicate device names
  const names = devices.map((d) => d.name);
  const unique = new Set(names);
  if (unique.size !== names.length) {
    throw new Error('Duplicate device names found in configuration');
  }

  // Keep optional verify section if provided
  const normalized = { ...parsed, devices, verify: parsed.verify } as ConfigSchema;

  // Allow MQTT password to be set via environment variables.
  // Precedence: MQTT_PASSWORD_FILE > MQTT_PASSWORD > YAML value
  const filePathEnv = process.env.MQTT_PASSWORD_FILE;
  if (filePathEnv) {
    // Throw if file cannot be read - required when secret file is set
    if (!fs.existsSync(filePathEnv)) {
      throw new Error(`MQTT_PASSWORD_FILE is set but file not found: ${filePathEnv}`);
    }
    const fileContent = fs.readFileSync(filePathEnv, 'utf8').trim();
    normalized.mqtt.password = fileContent;
  } else if (process.env.MQTT_PASSWORD) {
    normalized.mqtt.password = process.env.MQTT_PASSWORD;
  }
  return normalized;
}
