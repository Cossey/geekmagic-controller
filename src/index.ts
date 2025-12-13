import { loadConfig } from './config';
import DeviceController from './deviceController';
import MqttService from './mqttClient';
import { log, warn } from './logger';

async function main() {
  try {
    const cfgFile = process.argv[2] || undefined;
    const cfg = loadConfig(cfgFile);
  const controller = new DeviceController(cfg.devices, cfg.verify);
    const mqtt = new MqttService(cfg.mqtt, controller);
  mqtt.start();
    // Wire DeviceController to publish state back to MQTT with retain
    controller.setMqttPublisher(mqtt.publishState.bind(mqtt));
    // Wire DeviceController to publish image status events to <basetopic>/<device>/IMAGE/STATUS
    controller.setImageStatusPublisher(async (deviceName: string, payload: string, retain = false) => {
      const topic = `${cfg.mqtt.basetopic}/${deviceName}/IMAGE/STATUS`;
      await mqtt.publish(topic, payload, { retain });
    });
    // Start periodic polling after MQTT connects so retained state is published over a connected client.
    mqtt.onConnect(() => controller.startStatePolling());
    const shutdown = async (sig: string) => {
      log(sig, 'received - shutting down');
      controller.stopStatePolling();
      try {
        await mqtt.stop();
      } catch (e: any) {
        warn('Error while shutting down mqtt', e?.message || e);
      }
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err: any) {
    warn('Failed to start controller', err?.message || err);
    process.exit(1);
  }
}

main();
