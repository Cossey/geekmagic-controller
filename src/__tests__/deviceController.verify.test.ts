import DeviceController from '../deviceController';
import * as httpClient from '../httpClient';

const device = { name: 'lounge-tv', type: 'smalltv-ultra', host: '192.168.1.50' };

describe('DeviceController verifyCommand', () => {
  test('returns true when brightness matches on first try', async () => {
    const controller = new DeviceController([device], { afterCommand: true, retries: 2, initialDelayMs: 1, backoffMs: 1 });
    const publishSpy = jest.fn().mockResolvedValue(undefined as any);
    controller.setMqttPublisher(publishSpy as any);
    const spy = jest.spyOn(httpClient, 'getJson').mockResolvedValue({ brt: 55 });
    const ok = await controller.verifyCommand(device as any, 'BRIGHTNESS', 55);
    expect(ok).toBe(true);
    expect(publishSpy).toHaveBeenCalledWith(device.name, { brt: 55 }, true);
    spy.mockRestore();
  });

  test('returns true when theme matches after retry', async () => {
    const controller = new DeviceController([device], { afterCommand: true, retries: 3, initialDelayMs: 1, backoffMs: 1 });
    const publishSpy = jest.fn().mockResolvedValue(undefined as any);
    controller.setMqttPublisher(publishSpy as any);
    const spy = jest.spyOn(httpClient, 'getJson')
      .mockResolvedValueOnce({ theme: 0 })
      .mockResolvedValueOnce({ theme: 2 })
      .mockResolvedValueOnce({ theme: 2 });
    const ok = await controller.verifyCommand(device as any, 'THEME', 2);
    expect(ok).toBe(true);
    expect(publishSpy).toHaveBeenCalledWith(device.name, { theme: 2 }, true);
    spy.mockRestore();
  });

  test('returns false when value never matches', async () => {
    const controller = new DeviceController([device], { afterCommand: true, retries: 2, initialDelayMs: 1, backoffMs: 1 });
    const publishSpy = jest.fn().mockResolvedValue(undefined as any);
    controller.setMqttPublisher(publishSpy as any);
    const spy = jest.spyOn(httpClient, 'getJson').mockResolvedValue({ brt: 10 });
    const ok = await controller.verifyCommand(device as any, 'BRIGHTNESS', 55);
    expect(ok).toBe(false);
    expect(publishSpy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('handleCommand publishes immediately when afterCommand is false', async () => {
    const controller = new DeviceController([device], { afterCommand: false });
    const publishSpy = jest.fn().mockResolvedValue(undefined as any);
    controller.setMqttPublisher(publishSpy as any);
    const sendSpy = jest.spyOn(httpClient, 'sendGet').mockResolvedValue(null as any);

    await controller.handleCommand(device.name, 'BRIGHTNESS', '77');
    expect(sendSpy).toHaveBeenCalled();
    expect(publishSpy).toHaveBeenCalledWith(device.name, { brt: 77 }, true);
    sendSpy.mockRestore();
  });

  test('verify COLONBLINK reads colon.json and publishes numeric value', async () => {
    const controller = new DeviceController([device], { afterCommand: true, retries: 2, initialDelayMs: 1, backoffMs: 1 });
    const publishSpy = jest.fn().mockResolvedValue(undefined as any);
    controller.setMqttPublisher(publishSpy as any);
    const spy = jest.spyOn(httpClient, 'getJson').mockResolvedValue({ colon: 1 });
    const ok = await controller.verifyCommand(device as any, 'COLONBLINK', 1);
    expect(ok).toBe(true);
    expect(publishSpy).toHaveBeenCalledWith(device.name, { colon: 1 }, true);
    spy.mockRestore();
  });

  test('verify 12HOUR reads hour12.json and publishes numeric value', async () => {
    const controller = new DeviceController([device], { afterCommand: true, retries: 2, initialDelayMs: 1, backoffMs: 1 });
    const publishSpy = jest.fn().mockResolvedValue(undefined as any);
    controller.setMqttPublisher(publishSpy as any);
    const spy = jest.spyOn(httpClient, 'getJson').mockResolvedValue({ h: 0 });
    const ok = await controller.verifyCommand(device as any, '12HOUR', 0);
    expect(ok).toBe(true);
    expect(publishSpy).toHaveBeenCalledWith(device.name, { hour12: 0 }, true);
    spy.mockRestore();
  });

  test('verify DST reads dst.json and publishes numeric value', async () => {
    const controller = new DeviceController([device], { afterCommand: true, retries: 2, initialDelayMs: 1, backoffMs: 1 });
    const publishSpy = jest.fn().mockResolvedValue(undefined as any);
    controller.setMqttPublisher(publishSpy as any);
    const spy = jest.spyOn(httpClient, 'getJson').mockResolvedValue({ dst: 0 });
    const ok = await controller.verifyCommand(device as any, 'DST', 0);
    expect(ok).toBe(true);
    expect(publishSpy).toHaveBeenCalledWith(device.name, { dst: 0 }, true);
    spy.mockRestore();
  });

  test('verifyCommand sets device OFFLINE on HTTP error', async () => {
    const controller = new DeviceController([device], { afterCommand: true, retries: 1, initialDelayMs: 1, backoffMs: 1 });
    const statusSpy = jest.fn().mockResolvedValue(undefined as any);
    controller.setStatusPublisher(statusSpy as any);
    const spy = jest.spyOn(httpClient, 'getJson').mockResolvedValue(null as any);
    const ok = await controller.verifyCommand(device as any, 'BRIGHTNESS', 55);
    expect(ok).toBe(false);
    expect(statusSpy).toHaveBeenCalledWith(device.name, 'OFFLINE', true);
    spy.mockRestore();
  });
});
