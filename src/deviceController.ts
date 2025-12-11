import { Device } from './types';
import type { MqttPublishFn } from './types';
import { sendGet, getJson } from './httpClient';
import { log, warn } from './logger';

export class DeviceController {
  devicesByName: Map<string, Device>;
  verifyOptions: any;
  deviceStates: Map<string, { brt?: number; theme?: number; colon?: number; hour12?: number; dst?: number }> = new Map();
  devicePollTimers: Map<string, NodeJS.Timeout> = new Map();
  mqttPublisher?: MqttPublishFn;

  constructor(devices: Device[], verifyOptions?: any) {
    this.devicesByName = new Map(devices.map((d) => [d.name, d]));
    this.verifyOptions = verifyOptions || {};
  }

  setMqttPublisher(p: MqttPublishFn) {
    this.mqttPublisher = p;
  }

  getDevice(name: string): Device | undefined {
    return this.devicesByName.get(name);
  }

  async handleCommand(deviceName: string, command: string, payload: string): Promise<void> {
    const device = this.getDevice(deviceName);
    if (!device) {
      warn('Device not found', deviceName);
      return;
    }
    const cmd = command?.toUpperCase();
    const url = this.buildCommandUrl(device, command, payload);
    if (!url) {
      warn('Unsupported command', command, 'for device', deviceName);
      return;
    }
    log('Sending to device', deviceName, url);
    await sendGet(url);
    // After command is sent, optionally verify via JSON endpoints
    const verify = this.verifyOptions?.afterCommand;
    if (verify && (cmd === 'THEME' || cmd === 'BRIGHTNESS' || cmd === 'COLONBLINK' || cmd === '12HOUR' || cmd === 'DST')) {
      const expected = Number(payload);
      // only verify for numeric commands
      if (Number.isInteger(expected)) {
        const ok = await this.verifyCommand(device, cmd, expected);
        if (!ok) {
          warn('Verification failed for', command, 'on device', deviceName);
        }
      }
    }
    // If verification is disabled, assume success and update cached state + publish to MQTT
    if (!verify && (cmd === 'BRIGHTNESS' || cmd === 'THEME' || cmd === 'COLONBLINK' || cmd === '12HOUR' || cmd === 'DST')) {
      const expected = Number(payload);
      if (Number.isInteger(expected)) {
        const partial: { brt?: number; theme?: number; colon?: number; hour12?: number; dst?: number } = {};
        if (cmd === 'BRIGHTNESS') partial.brt = expected;
        if (cmd === 'THEME') partial.theme = expected;
        if (cmd === 'COLONBLINK') partial.colon = expected;
        if (cmd === '12HOUR') partial.hour12 = expected;
        if (cmd === 'DST') partial.dst = expected;
        this.maybePublishState(deviceName, partial);
      }
    }
  }

  buildCommandUrl(device: Device, command: string, payload: string): string | null {
    const root = `http://${device.host}/set`;
    const cmd = command?.toUpperCase();
    switch (cmd) {
      case 'COLONBLINK': {
        // accepts YES/NO or numeric 1/0
        const val = payload?.toString().trim().toUpperCase();
        let num: number | null = null;
        if (val === 'YES' || val === '1' || val === 'TRUE' || val === 'ON') num = 1;
        if (val === 'NO' || val === '0' || val === 'FALSE' || val === 'OFF') num = 0;
        if (num === null) {
          warn('Invalid boolean payload for COLONBLINK', payload);
          return null;
        }
        return `${root}?colon=${num}`;
      }
      case '12HOUR': {
        const val = payload?.toString().trim().toUpperCase();
        let num: number | null = null;
        if (val === 'YES' || val === '1' || val === 'TRUE' || val === 'ON') num = 1;
        if (val === 'NO' || val === '0' || val === 'FALSE' || val === 'OFF') num = 0;
        if (num === null) {
          warn('Invalid boolean payload for 12HOUR', payload);
          return null;
        }
        return `${root}?hour=${num}`;
      }
      case 'DST': {
        const val = payload?.toString().trim().toUpperCase();
        let num: number | null = null;
        if (val === 'YES' || val === '1' || val === 'TRUE' || val === 'ON') num = 1;
        if (val === 'NO' || val === '0' || val === 'FALSE' || val === 'OFF') num = 0;
        if (num === null) {
          warn('Invalid boolean payload for DST', payload);
          return null;
        }
        return `${root}?dst=${num}`;
      }
      case 'THEME': {
        const value = Number(payload);
        if (!Number.isFinite(value) || !Number.isInteger(value)) {
          warn('Invalid numeric payload for THEME', payload);
          return null;
        }
        // Accept only integer values between 1 and 7
        if (value < 1 || value > 7) {
          warn('THEME payload out of range (1-7)', payload);
          return null;
        }
        return `${root}?theme=${value}`;
      }
      case 'BRIGHTNESS': {
        const value = Number(payload);
        if (!Number.isFinite(value) || !Number.isInteger(value)) {
          warn('Invalid numeric payload for BRIGHTNESS', payload);
          return null;
        }
        // Accept only integer values between 0 and 100
        if (value < 0 || value > 100) {
          warn('BRIGHTNESS payload out of range (0-100)', payload);
          return null;
        }
        return `${root}?brt=${value}`;
      }
      case 'COMMAND': {
        // The COMMAND item can contain different textual commands; currently only 'REBOOT' is supported
        const cmdText = (payload || '').toString().toUpperCase();
        if (cmdText === 'REBOOT') {
          return `${root}?reboot=1`;
        }
        warn('Unsupported COMMAND payload', payload);
        return null;
      }
      case 'DISPLAY':
        // Not implemented yet; return null so caller can log
        return null;
      default:
        return null;
    }
  }

  // Verify a command by querying the appropriate JSON file and checking expected value.
  async verifyCommand(device: Device, command: string, expected: number): Promise<boolean> {
    const retries = this.verifyOptions?.retries ?? 3;
    const initialDelay = this.verifyOptions?.initialDelayMs ?? 300;
    const backoff = this.verifyOptions?.backoffMs ?? 200;

    const host = device.host;
    let file: string;
    let key: string;
  switch (command?.toUpperCase()) {
      case 'BRIGHTNESS':
        file = 'brt.json';
        key = 'brt';
        break;
      case 'THEME':
        file = 'app.json';
        key = 'theme';
        break;
      case 'COLONBLINK':
        file = 'colon.json';
        key = 'colon';
        break;
      case '12HOUR':
        file = 'hour12.json';
        key = 'h';
        break;
      case 'DST':
        file = 'dst.json';
        key = 'dst';
        break;
      default:
        return false;
    }

    let attempt = 0;
    let delay = initialDelay;
    while (attempt < retries) {
      attempt++;
      try {
  const url = `http://${host}/${file}`;
  const data = await getJson(url);
        if (data && typeof data === 'object') {
          const current = data[key];
          if (Number(current) === expected) {
            log('Verification matched', command, 'for', device.name, expected);
            // update cached state and publish
            const partial: { brt?: number; theme?: number; colon?: number; hour12?: number; dst?: number } = {};
            if (key === 'brt') partial.brt = expected;
            if (key === 'theme') partial.theme = expected;
            if (key === 'colon') partial.colon = expected;
            if (key === 'h') partial.hour12 = expected;
            if (key === 'dst') partial.dst = expected;
            this.maybePublishState(device.name, partial);
            return true;
          }
        }
      } catch (err: any) {
        warn('Verification fetch error', err?.message || err);
      }
      // wait for delay
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay += backoff;
    }
    return false;
  }

  // Fetch current device state for both brt and app and update internal map
  async loadDeviceState(device: Device): Promise<void> {
    try {
      const brtData = await getJson(`http://${device.host}/brt.json`);
      const appData = await getJson(`http://${device.host}/app.json`);
      const colonData = await getJson(`http://${device.host}/colon.json`);
      const hour12Data = await getJson(`http://${device.host}/hour12.json`);
      const dstData = await getJson(`http://${device.host}/dst.json`);
      const partial: { brt?: number; theme?: number; colon?: number; hour12?: number; dst?: number } = {};
      if (brtData && typeof brtData === 'object') {
        if ('brt' in brtData) partial.brt = Number((brtData as any).brt);
        else if ('value' in brtData) partial.brt = Number((brtData as any).value);
        else if ('brightness' in brtData) partial.brt = Number((brtData as any).brightness);
      }
      if (appData && typeof appData === 'object') {
        if ('theme' in appData) partial.theme = Number((appData as any).theme);
        else if ('app' in appData && appData.app && typeof appData.app === 'object' && 'theme' in appData.app) {
          partial.theme = Number((appData as any).app.theme);
        }
      }
      if (colonData && typeof colonData === 'object' && 'colon' in colonData) {
        partial.colon = Number((colonData as any).colon);
      }
      if (hour12Data && typeof hour12Data === 'object' && 'h' in hour12Data) {
        partial.hour12 = Number((hour12Data as any).h);
      }
      if (dstData && typeof dstData === 'object' && 'dst' in dstData) {
        partial.dst = Number((dstData as any).dst);
      }
      // update cache and publish as needed
  this.maybePublishState(device.name, partial);
    } catch (err: any) {
      warn('Failed to load device state for', device.name, err?.message || err);
    }
  }

  // Merge the partial state into the cached state and publish to MQTT if changed (or initially set)
  private async maybePublishState(deviceName: string, partial: { brt?: number; theme?: number; colon?: number; hour12?: number; dst?: number }): Promise<void> {
    const prev = this.deviceStates.get(deviceName);
    const next = { ...(prev || {}), ...partial };
    this.deviceStates.set(deviceName, next);
    // Only publish when we have keys in the partial update
    const partialKeys = Object.keys(partial);
    if (partialKeys.length === 0) return;

    // determine if there was a change to any key provided in partial or prev absent
    let changed = false;
    if (!prev) changed = true;
    else changed = partialKeys.some((k) => (partial as any)[k] !== (prev as any)[k]);
    if (this.mqttPublisher && changed) {
      try {
        await this.mqttPublisher(deviceName, partial, true);
      } catch (err: any) {
        warn('Failed to publish state for', deviceName, err?.message || err);
      }
    }
  }

  // Load state for all devices once (for initial state) or when called
  async loadStateForAllDevices(): Promise<void> {
    const loads = Array.from(this.devicesByName.values()).map((d) => this.loadDeviceState(d));
    await Promise.all(loads);
  }

  // Start periodic polling of device states; each device may set their own interval via `device.polling`.
  // If device.polling is 0, polling for that device is disabled, but initial state is still loaded.
  startStatePolling(defaultIntervalSeconds?: number): void {
    // clear existing per-device timers
    this.devicePollTimers.forEach((timer) => clearInterval(timer));
    this.devicePollTimers.clear();

    // initial load for all devices
    this.loadStateForAllDevices();

    for (const device of this.devicesByName.values()) {
      const pol = device.polling !== undefined ? device.polling : (this.verifyOptions?.pollIntervalSeconds ?? defaultIntervalSeconds ?? 30);
      if (pol && pol > 0) {
        const intervalMs = pol * 1000;
  const timer = setInterval(() => this.loadDeviceState(device), intervalMs);
  // ensure timers don't keep the node event loop alive by test runs
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
        this.devicePollTimers.set(device.name, timer);
      }
    }
  }

  stopStatePolling(): void {
    this.devicePollTimers.forEach((t) => clearInterval(t));
    this.devicePollTimers.clear();
  }

  getState(deviceName: string): { brt?: number; theme?: number; colon?: number; hour12?: number; dst?: number } | undefined {
    return this.deviceStates.get(deviceName);
  }
}

export default DeviceController;
