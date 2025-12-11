import MqttService from '../mqttClient';
import DeviceController from '../deviceController';
import * as httpClient from '../httpClient';
import * as mqttLib from 'mqtt';

const cfg = { server: '127.0.0.1', port: 1883, basetopic: 'gm' } as any;

describe('MqttService message handling', () => {

  test('full path: device/<ITEM>/SET topic triggers command, sendGet, and publishes state', async () => {
    const device = { name: 'lounge-tv', type: 'smalltv-ultra', host: '192.168.1.50' } as any;
    const controller = new DeviceController([device], { afterCommand: false });
    const mqtt = new MqttService(cfg, controller as any);
    const publishSpy = jest.fn().mockResolvedValue(undefined as any);
    controller.setMqttPublisher(publishSpy as any);
    const sendSpy = jest.spyOn(httpClient, 'sendGet').mockResolvedValue(null as any);

  await mqtt.handleMessage('gm/lounge-tv/BRIGHTNESS/SET', Buffer.from('77'));
    expect(sendSpy).toHaveBeenCalled();
    expect(publishSpy).toHaveBeenCalledWith('lounge-tv', { brt: 77 }, true);
    sendSpy.mockRestore();
  });

  test('ignores direct gm/<device>/<ITEM> publishes and does not treat them as commands', async () => {
    const controller = { handleCommand: jest.fn().mockResolvedValue(null) } as any;
    const mqtt = new MqttService(cfg, controller);
    await mqtt.handleMessage('gm/lounge-tv/THEME', Buffer.from('1'));
    expect(controller.handleCommand).not.toHaveBeenCalled();
  });

  test('SET topic with colon separated payload is handled (device/<ITEM>/SET)', async () => {
    const controller = { handleCommand: jest.fn().mockResolvedValue(null) } as any;
    const mqtt = new MqttService(cfg, controller);

  await mqtt.handleMessage('gm/lounge-tv/BRIGHTNESS/SET', Buffer.from('55'));
  // No debug logging
    expect(controller.handleCommand).toHaveBeenCalledWith('lounge-tv', 'BRIGHTNESS', '55');
  });

  test('SET topic with JSON payload is handled (device/<ITEM>/SET)', async () => {
    const controller = { handleCommand: jest.fn().mockResolvedValue(null) } as any;
    const mqtt = new MqttService(cfg, controller);

  await mqtt.handleMessage('gm/lounge-tv/BRIGHTNESS/SET', Buffer.from(JSON.stringify({ value: 55 })));
  expect(controller.handleCommand).toHaveBeenCalledWith('lounge-tv', 'BRIGHTNESS', '55');
  });

  test('COMMAND topic with REBOOT payload triggers reboot', async () => {
    const device = { name: 'lounge-tv', type: 'smalltv-ultra', host: '192.168.1.50' } as any;
    const controller = new (require('../deviceController').default)([device], { afterCommand: false });
    const mqtt = new MqttService(cfg, controller as any);
    const publishSpy = jest.fn().mockResolvedValue(undefined as any);
    controller.setMqttPublisher(publishSpy as any);
    const sendSpy = jest.spyOn(require('../httpClient'), 'sendGet').mockResolvedValue(null as any);

    await mqtt.handleMessage('gm/lounge-tv/COMMAND', Buffer.from('REBOOT'));
    expect(sendSpy).toHaveBeenCalled();
    sendSpy.mockRestore();
  });

  test('publishState publishes to <device>/<ITEM> topics', async () => {
    const controller = { handleCommand: jest.fn() } as any;
    const mqtt = new MqttService(cfg, controller);
    const pubSpy = jest.spyOn(mqtt as any, 'publish' as any).mockResolvedValue(undefined as any);
    await mqtt.publishState('lounge-tv', { brt: 55, theme: 3 }, true);
  expect(pubSpy).toHaveBeenCalledWith('gm/lounge-tv/BRIGHTNESS', '55', { retain: true });
  expect(pubSpy).toHaveBeenCalledWith('gm/lounge-tv/THEME', '3', { retain: true });
    // Publishing boolean flags should show YES/NO
    await mqtt.publishState('lounge-tv', { colon: 1, hour12: 0, dst: 1 }, true);
    expect(pubSpy).toHaveBeenCalledWith('gm/lounge-tv/COLONBLINK', 'YES', { retain: true });
    expect(pubSpy).toHaveBeenCalledWith('gm/lounge-tv/12HOUR', 'NO', { retain: true });
    expect(pubSpy).toHaveBeenCalledWith('gm/lounge-tv/DST', 'YES', { retain: true });
    pubSpy.mockRestore();
  });

  test('SET topic with COLONBLINK/SET and boolean payload is handled', async () => {
    const controller = { handleCommand: jest.fn().mockResolvedValue(null) } as any;
    const mqtt = new MqttService(cfg, controller);

    await mqtt.handleMessage('gm/lounge-tv/COLONBLINK/SET', Buffer.from('YES'));
    expect(controller.handleCommand).toHaveBeenCalledWith('lounge-tv', 'COLONBLINK', 'YES');
  });

  test('SET topic with 12HOUR/SET and boolean payload is handled', async () => {
    const controller = { handleCommand: jest.fn().mockResolvedValue(null) } as any;
    const mqtt = new MqttService(cfg, controller);

    await mqtt.handleMessage('gm/lounge-tv/12HOUR/SET', Buffer.from('NO'));
    expect(controller.handleCommand).toHaveBeenCalledWith('lounge-tv', '12HOUR', 'NO');
  });

  test('SET topic with DST/SET and boolean payload is handled', async () => {
    const controller = { handleCommand: jest.fn().mockResolvedValue(null) } as any;
    const mqtt = new MqttService(cfg, controller);

    await mqtt.handleMessage('gm/lounge-tv/DST/SET', Buffer.from('1'));
    expect(controller.handleCommand).toHaveBeenCalledWith('lounge-tv', 'DST', '1');
  });

  // Note: testing the subscribe patterns via mqtt.connect mocking can be tricky - omit for now.
});
