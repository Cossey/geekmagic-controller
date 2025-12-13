import mqtt from 'mqtt';
import { MQTTConfig } from './types';
import DeviceController from './deviceController';
import { log, warn } from './logger';

export class MqttService {
  client: mqtt.MqttClient | null = null;
  cfg: MQTTConfig;
  controller: DeviceController;
  // Optional connect function for test injection
  connectFn?: (url: string, options: mqtt.IClientOptions) => mqtt.MqttClient;

  constructor(cfg: MQTTConfig, controller: DeviceController, connectFn?: (url: string, options: mqtt.IClientOptions) => mqtt.MqttClient) {
    this.cfg = cfg;
    this.controller = controller;
    this.connectFn = connectFn;
  }

  private getStatusTopic(): string {
    const raw = String(this.cfg.basetopic || 'gm');
    const base = raw.replace(/^\/+|\/+$/g, ''); // remove leading/trailing slashes
    return `${base}/STATUS`;
  }

  start() {
    const url = `mqtt://${this.cfg.server}:${this.cfg.port}`;
    const options: mqtt.IClientOptions = {
      clientId: this.cfg.client,
      username: this.cfg.user,
      password: this.cfg.password,
      reconnectPeriod: 5000
    };
    // Add Last Will and Testament: if this client disconnects unexpectedly, the broker
    // should publish OFFLINE to /<basetopic>/STATUS as retained so subscribers know the
    // controller is offline.
    options.will = {
      topic: this.getStatusTopic(),
      payload: 'OFFLINE',
      qos: 0,
      retain: true,
    };
    log('Connecting to MQTT', url);
  const connectToUse = this.connectFn ?? mqtt.connect;
  this.client = connectToUse(url, options);
    this.client.on('connect', () => {
      log('MQTT connected');
  // Only subscribe to item-level SET and COMMAND subtopics to avoid interpreting state topics as commands.
  // Use one device and item level: <basetopic>/<device>/<item>/SET
  // Also subscribe to IMAGE/GENERATE which is a command-style topic (no /SET suffix)
  const topics = [`${this.cfg.basetopic}/+/+/SET`, `${this.cfg.basetopic}/+/COMMAND`, `${this.cfg.basetopic}/+/IMAGE/GENERATE`];
      log('Subscribing to topics', topics.join(', '));
      this.client?.subscribe(topics, (err?: Error, granted?: mqtt.ISubscriptionGrant[]) => {
        if (err) {
          warn('Subscription error', err.message || err);
          return;
        }
        log('MQTT subscribed', granted?.map(g => g.topic).join(', '));
      });
  // Publish retained ONLINE status after successful connect
  this.publish(this.getStatusTopic(), 'ONLINE', { retain: true }).catch((err) => warn('Failed to publish ONLINE status', err?.message || err));
    });

    this.client.on('message', (topic: string, message: Buffer) => {
      // delegate to helper (no need to await in the event handler)
      this.handleMessage(topic, message).catch((err) => warn('Error handling mqtt message', err?.message || err));
    });

    this.client.on('error', (err: Error) => {
      warn('MQTT error', err?.message || err);
    });
    // When the client closes, ensure we log; LWT is used to mark the broker-side offline
    // state in the event of unexpected disconnects, but we also log locally on close.
    this.client.on('close', () => log('MQTT connection closed'));
  }

  // Gracefully stop the mqtt client and publish OFFLINE retained status when possible
  async stop(): Promise<void> {
    if (!this.client) return;
    try {
  await this.publish(this.getStatusTopic(), 'OFFLINE', { retain: true });
    } catch (err: any) {
      // Ignore publish errors but log
      warn('Failed to publish OFFLINE status', err?.message || err);
    }
    try {
      // close the connection cleanly
      this.client.end();
    } catch (err: any) {
      // ignore and log
      warn('Error ending MQTT client', err?.message || err);
    }
  }

  // Allow external code to register a connect handler
  onConnect(cb: () => void) {
    if (this.client) {
      if ((this.client as any).connected) cb();
      else this.client.on('connect', cb);
      return;
    }
    // If there is no client yet, create a listener for when start() sets it. Poll until the client exists.
    const interval = setInterval(() => {
      if (this.client) {
        if ((this.client as any).connected) cb();
        else this.client.on('connect', cb);
        clearInterval(interval);
      }
    }, 50);
  }

  // Parse topic and payload and dispatch to controller.handleCommand
  async handleMessage(topic: string, message: Buffer): Promise<void> {
    const parts = topic.split('/');
    if (parts.length < 3) {
      warn('MQTT topic malformed', topic);
      return;
    }
    if (parts[0] !== this.cfg.basetopic) {
      // ignore topics outside base
      return;
    }
    const device = parts[1];
    const payloadRaw = message.toString();
    // If the topic is gm/device/<ITEM>/SET -> pattern length 4 and last part is SET
    if (parts.length >= 4 && parts[3].toUpperCase() === 'SET') {
      const item = parts[2];
      log('MQTT received', { topic, device, item, payload: payloadRaw });
      // For this pattern, payload can be plain value like '55' or JSON { value: 55 }
      let payloadVal = '';
      try {
        const parsed = JSON.parse(payloadRaw);
        if (parsed && typeof parsed === 'object') {
          payloadVal = parsed.value !== undefined ? String(parsed.value) : String(parsed.payload ?? '');
        } else if (typeof parsed === 'number' || typeof parsed === 'string') {
          payloadVal = String(parsed);
        }
      } catch (_) {
        // Not JSON; treat as plain value
        payloadVal = payloadRaw.trim();
      }
      await this.controller.handleCommand(device, item, payloadVal);
      return;
    }

    // Special IMAGE/GENERATE topic: gm/<device>/IMAGE/GENERATE
    if (parts.length >= 4 && parts[2].toUpperCase() === 'IMAGE' && parts[3].toUpperCase() === 'GENERATE') {
      log('MQTT received IMAGE/GENERATE', { topic, device, payload: payloadRaw });
      // payload can be JSON or plain text
      let payloadVal: any = undefined;
      try {
        payloadVal = JSON.parse(payloadRaw);
      } catch (_) {
        payloadVal = String(payloadRaw).trim();
      }
      // Call controller to generate and upload image
      // Do not await to avoid blocking the mqtt message loop
      this.controller.generateAndUploadImage(device, payloadVal).catch((err) => warn('IMAGE/GENERATE failed', err?.message || err));
      return;
    }

    // If the topic is gm/device/COMMAND -> textual commands like 'REBOOT'
    const subtopic = parts[2];
    log('MQTT received', { topic, device, subtopic, payload: payloadRaw });
    if (subtopic.toUpperCase() === 'COMMAND') {
      // accept simple text payload like 'REBOOT' or JSON like { command: 'REBOOT' }
      let cmdText = '';
      try {
        const parsed = JSON.parse(payloadRaw);
        if (parsed && typeof parsed === 'object') {
          cmdText = String(parsed.command || parsed.cmd || parsed.value || '').toUpperCase();
        } else if (typeof parsed === 'string' || typeof parsed === 'number') {
          // JSON string/number
          cmdText = String(parsed).toUpperCase();
        }
      } catch (_) {
        // not JSON, treat plain text
        cmdText = payloadRaw.trim().toUpperCase();
      }
      if (cmdText === '') {
        warn('COMMAND payload missing', payloadRaw);
        return;
      }
      // Only support REBOOT for now
      if (cmdText === 'REBOOT') {
        await this.controller.handleCommand(device, 'COMMAND', 'REBOOT');
        return;
      }
      warn('Unsupported COMMAND payload', payloadRaw);
      return;
    }

    warn('MQTT topic not supported', topic);
    return;
  }

  // Generic publish helper which returns a promise
  async publish(topic: string, payload: string, options: mqtt.IClientPublishOptions = { qos: 0, retain: false }): Promise<void> {
    if (!this.client) {
      warn('MQTT client not connected; cannot publish', topic);
      return;
    }
    return new Promise<void>((resolve, reject) => {
      this.client!.publish(topic, payload, options, (err?: Error) => {
        if (err) {
          warn('MQTT publish error', err?.message || err);
          return reject(err);
        }
        resolve();
      });
    });
  }

  // Publish device state to retained topics for BRIGHTNESS and THEME.
  // These topics are read-only state topics and should not be interpreted as commands. Commands
  // are accepted on the SET subtopic (e.g., BRIGHTNESS/SET, THEME/SET) and COMMAND.
  async publishState(deviceName: string, state: { brt?: number; theme?: number; colon?: number; hour12?: number; dst?: number }, retain = true): Promise<void> {
    const topicBase = `${this.cfg.basetopic}/${deviceName}`;
    const publishes: Promise<void>[] = [];
    if (typeof state.brt === 'number') {
      publishes.push(this.publish(`${topicBase}/BRIGHTNESS`, String(state.brt), { retain }));
    }
    if (typeof state.theme === 'number') {
      publishes.push(this.publish(`${topicBase}/THEME`, String(state.theme), { retain }));
    }
    if (typeof state.colon === 'number') {
      const payload = state.colon === 1 ? 'YES' : 'NO';
      publishes.push(this.publish(`${topicBase}/COLONBLINK`, payload, { retain }));
    }
    if (typeof state.hour12 === 'number') {
      const payload = state.hour12 === 1 ? 'YES' : 'NO';
      publishes.push(this.publish(`${topicBase}/12HOUR`, payload, { retain }));
    }
    if (typeof state.dst === 'number') {
      const payload = state.dst === 1 ? 'YES' : 'NO';
      publishes.push(this.publish(`${topicBase}/DST`, payload, { retain }));
    }
    if (publishes.length > 0) await Promise.all(publishes);
  }
}

export default MqttService;
