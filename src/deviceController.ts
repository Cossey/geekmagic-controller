import { Device } from './types';
import type { MqttPublishFn } from './types';
import * as httpClient from './httpClient';
import Jimp from 'jimp';
import sharp from 'sharp';
import { log, warn } from './logger';

export class DeviceController {
  devicesByName: Map<string, Device>;
  verifyOptions: any;
  deviceStates: Map<string, { brt?: number; theme?: number; colon?: number; hour12?: number; dst?: number }> = new Map();
  devicePollTimers: Map<string, NodeJS.Timeout> = new Map();
  mqttPublisher?: MqttPublishFn;
  // Optional override hook used by tests to intercept image uploads.
  // signature: device, buffer, filename, contentType
  imageUploader?: (device: Device, buf: Buffer, filename: string, contentType: string) => Promise<boolean>;
  // Optional override for HTTP GET requests (used in tests for image flow)
  sendGetFn?: (url: string) => Promise<any>;

  constructor(devices: Device[], verifyOptions?: any) {
    this.devicesByName = new Map(devices.map((d) => [d.name, d]));
    this.verifyOptions = verifyOptions || {};
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
    // Special handling for IMAGE uploads
    if (cmd === 'IMAGE') {
      try {
        const ok = await this.processImageAndUpload(device, payload);
        if (!ok) warn('IMAGE upload failed for', deviceName);
      } catch (err: any) {
        warn('IMAGE upload error', err?.message || err);
      }
      return;
    }
    const url = this.buildCommandUrl(device, command, payload);
    if (!url) {
      warn('Unsupported command', command, 'for device', deviceName);
      return;
    }
  log('Sending to device', deviceName, url);
  await httpClient.sendGet(url);
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
  const data = await httpClient.getJson(url);
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
      // wait for delay (unref the timer so it doesn't keep the process alive)
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        const t = setTimeout(resolve, delay);
        if (typeof (t as any).unref === 'function') (t as any).unref();
      });
      delay += backoff;
    }
    return false;
  }

  // Process an image/gif payload, resize/crop to 240x240 according to device.image settings,
  // upload to the device via POST to /upload and set THEME to 3 on success.
  async processImageAndUpload(device: Device, payload: string): Promise<boolean> {
    // Decode payload: support data URI (data:<mime>;base64,...) or raw base64
    let buffer: Buffer;
    let dataUriMime: string | undefined;
    try {
      const m = String(payload || '').match(/^data:([^;]+);base64,(.*)$/i);
      if (m) {
        dataUriMime = m[1].toLowerCase();
        buffer = Buffer.from(m[2], 'base64');
      } else {
        // Try plain base64
        buffer = Buffer.from(String(payload || ''), 'base64');
      }
    } catch (err: any) {
      warn('Failed to decode IMAGE payload', err?.message || err);
      return false;
    }

    try {
      // Determine original MIME type. Prefer sniffing the buffer (magic bytes) over a declared data URI mime
      let origMime: string | undefined = dataUriMime;
      const s = buffer.slice(0, 8);
      const sig = s.toString('ascii', 0, 6);
      if (sig.startsWith('GIF')) origMime = 'image/gif';
      else if (s[0] === 0xff && s[1] === 0xd8) origMime = 'image/jpeg';
      else if (s[0] === 0x89 && s[1] === 0x50 && s[2] === 0x4e && s[3] === 0x47) origMime = 'image/png';

      const cfg = device.image || {};
      const oversize = cfg.oversize || 'resize';
      const cropposition = (cfg.cropposition || 'center') as string;

      const finalSize = 240;

      // Use sharp metadata to decide how to process and whether it's an animated GIF
      const meta = await sharp(buffer, { animated: true }).metadata();
      const format = (meta.format || '').toLowerCase();

      // Map crop position to sharp's position identifiers
      const mapPosition = (pos: string) => {
        switch ((pos || 'center').toLowerCase()) {
          case 'topleft': return 'northwest';
          case 'topright': return 'northeast';
          case 'bottomleft': return 'southwest';
          case 'bottomright': return 'southeast';
          case 'top': return 'north';
          case 'bottom': return 'south';
          case 'left': return 'west';
          case 'right': return 'east';
          default: return 'center';
        }
      };

      let finalBuffer: Buffer;
      let finalExt = 'jpg';
      let finalMime = 'image/jpeg';

      if (format === 'gif') {
        const w = meta.width || 0;
        const h = meta.height || 0;
        if (w === finalSize && h === finalSize) {
          // already the right size — upload GIF as-is
          finalBuffer = buffer;
          finalExt = 'gif';
          finalMime = 'image/gif';
        } else {
          // Resize/crop while preserving animation using sharp's animated pipeline
          const fit = oversize === 'crop' ? 'cover' : 'contain';
          const position = mapPosition(cropposition) as any;
          finalBuffer = await sharp(buffer, { animated: true })
            .resize(finalSize, finalSize, { fit: fit as any, position, background: { r: 255, g: 255, b: 255, alpha: 1 } })
            .gif()
            .toBuffer();
          finalExt = 'gif';
          finalMime = 'image/gif';
        }
      } else {
        // Non-GIF: normalize to JPG and ensure 240x240. When oversize=crop and source is larger,
        // compute an explicit extract region to match the Jimp-based crop behavior exactly.
        const w = meta.width || 0;
        const h = meta.height || 0;
        if (oversize === 'crop' && (w > finalSize || h > finalSize) && w >= finalSize && h >= finalSize) {
          // compute left/top based on cropposition
          let left = 0;
          let top = 0;
          const horizontalCenter = Math.max(0, Math.floor((w - finalSize) / 2));
          const verticalCenter = Math.max(0, Math.floor((h - finalSize) / 2));
          switch (cropposition.toLowerCase()) {
            case 'topleft':
              left = 0; top = 0; break;
            case 'topright':
              left = Math.max(0, w - finalSize); top = 0; break;
            case 'bottomleft':
              left = 0; top = Math.max(0, h - finalSize); break;
            case 'bottomright':
              left = Math.max(0, w - finalSize); top = Math.max(0, h - finalSize); break;
            case 'top':
              left = horizontalCenter; top = 0; break;
            case 'bottom':
              left = horizontalCenter; top = Math.max(0, h - finalSize); break;
            case 'left':
              left = 0; top = verticalCenter; break;
            case 'right':
              left = Math.max(0, w - finalSize); top = verticalCenter; break;
            default:
              left = horizontalCenter; top = verticalCenter; break;
          }
          finalBuffer = await sharp(buffer)
            .extract({ left, top, width: finalSize, height: finalSize })
            .jpeg({ quality: 90 })
            .toBuffer();
        } else {
          const position = mapPosition(cropposition) as any;
          finalBuffer = await sharp(buffer)
            .resize(finalSize, finalSize, { fit: 'contain', position, background: { r: 255, g: 255, b: 255, alpha: 1 } })
            .jpeg({ quality: 90 })
            .toBuffer();
        }
        finalExt = 'jpg';
        finalMime = 'image/jpeg';
      }

      const uploadUrl = `http://${device.host}/doUpload?dir=/image/`;
      const filename = `upload.${finalExt}`;
      const uploadOk = this.imageUploader ? await this.imageUploader(device, finalBuffer, filename, finalMime) : await httpClient.postForm(uploadUrl, 'image', finalBuffer, filename, finalMime);
      if (!uploadOk) return false;

      // set theme to 3 (allow tests to override sendGet via sendGetFn)
      const sendGetToUse = this.sendGetFn ?? httpClient.sendGet;
      await sendGetToUse(`http://${device.host}/set?theme=3`);
      // select the uploaded image
      const encodedPath = encodeURIComponent(`/image//upload.${finalExt}`);
      await sendGetToUse(`http://${device.host}/set?img=${encodedPath}`);

      // Publish theme or verify
      if (this.verifyOptions?.afterCommand) {
        await this.verifyCommand(device, 'THEME', 3);
      } else {
        this.maybePublishState(device.name, { theme: 3 });
      }
      return true;
    } catch (err: any) {
      warn('Image processing/upload failed', err?.message || err);
      return false;
    }
  }

  // Fetch current device state for both brt and app and update internal map
  async loadDeviceState(device: Device): Promise<void> {
    try {
  const brtData = await httpClient.getJson(`http://${device.host}/brt.json`);
  const appData = await httpClient.getJson(`http://${device.host}/app.json`);
  const colonData = await httpClient.getJson(`http://${device.host}/colon.json`);
  const hour12Data = await httpClient.getJson(`http://${device.host}/hour12.json`);
  const dstData = await httpClient.getJson(`http://${device.host}/dst.json`);
      const partial: { brt?: number; theme?: number; colon?: number; hour12?: number; dst?: number } = {};
      // Helper which looks up multiple possible keys and converts boolean/string forms to numbers
      // Supports optional recursive search up to a given depth (default 0 = only top-level)
      const parseNumericFrom = (data: any, keys: string[], depth = 0): number | undefined => {
        if (!data || typeof data !== 'object') return undefined;
        const tryTop = () => {
          for (const k of keys) {
            for (const objKey of Object.keys(data)) {
              if (objKey.toLowerCase() === k.toLowerCase()) {
                const v = (data as any)[objKey];
                if (typeof v === 'number' && Number.isFinite(v)) return Number(v);
                if (typeof v === 'boolean') return v ? 1 : 0;
                if (typeof v === 'string') {
                  const s = v.trim().toUpperCase();
                  if (s === 'YES' || s === 'TRUE' || s === 'ON') return 1;
                  if (s === 'NO' || s === 'FALSE' || s === 'OFF') return 0;
                  const n = Number(s);
                  if (Number.isFinite(n)) return n;
                }
              }
            }
          }
          return undefined;
        };

        const top = tryTop();
        if (top !== undefined) return top;
        if (depth <= 0) return undefined;
        for (const objKey of Object.keys(data)) {
          try {
            const nested = (data as any)[objKey];
            if (nested && typeof nested === 'object') {
              const found = parseNumericFrom(nested, keys, depth - 1);
              if (found !== undefined) return found;
            }
          } catch (e) {
            // ignore and continue
          }
        }
        return undefined;
      };

      // brightness
      const brtVal = parseNumericFrom(brtData, ['brt', 'value', 'brightness']);
      if (brtVal !== undefined) partial.brt = brtVal;

      // theme: check theme or nested app.theme or other numeric keys
      let themeVal = parseNumericFrom(appData, ['theme', 'value']);
      if (themeVal === undefined && appData && typeof appData === 'object' && 'app' in appData && appData.app && typeof appData.app === 'object') {
        themeVal = parseNumericFrom(appData.app, ['theme', 'value']);
      }
      if (themeVal !== undefined) partial.theme = themeVal;

  // colon/hour12/dst - if missing on dedicated endpoints, search inside appData up to 2 levels
  const colonVal = parseNumericFrom(colonData, ['colon', 'value']) ?? parseNumericFrom(appData, ['colon', 'colonblink', 'value'], 2);
  if (colonVal !== undefined) partial.colon = colonVal;
  const hour12Val = parseNumericFrom(hour12Data, ['h', 'hour12', 'value']) ?? parseNumericFrom(appData, ['h', 'hour12', '12hour', 'value'], 2);
  if (hour12Val !== undefined) partial.hour12 = hour12Val;
  const dstVal = parseNumericFrom(dstData, ['dst', 'value']) ?? parseNumericFrom(appData, ['dst', 'daylight', 'value'], 2);
  if (dstVal !== undefined) partial.dst = dstVal;
    // update cache and publish as needed (force publish on poll/initial load)
  log('Loaded state for', device.name, partial);
  this.maybePublishState(device.name, partial, true);
    } catch (err: any) {
      warn('Failed to load device state for', device.name, err?.message || err);
    }
  }

  // Merge the partial state into the cached state and publish to MQTT if changed (or initially set)
  private async maybePublishState(deviceName: string, partial: { brt?: number; theme?: number; colon?: number; hour12?: number; dst?: number }, forcePublish = false): Promise<void> {
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
    if (this.mqttPublisher && (changed || forcePublish)) {
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
  async startStatePolling(defaultIntervalSeconds?: number): Promise<void> {
    // clear existing per-device timers
    this.devicePollTimers.forEach((timer) => clearInterval(timer));
    this.devicePollTimers.clear();

    // initial load for all devices
    // wait for initial load to complete so callers/tests can observe initial state
    await this.loadStateForAllDevices();

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
