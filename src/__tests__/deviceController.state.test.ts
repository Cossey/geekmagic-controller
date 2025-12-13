import DeviceController from '../deviceController';
import * as httpClient from '../httpClient';

const device = { name: 'lounge-tv', type: 'smalltv-ultra', host: '192.168.1.50' };

describe('DeviceController state load', () => {
  test('loads device state from brt.json and app.json', async () => {
    const controller = new DeviceController([device]);
  const publishSpy = jest.fn().mockResolvedValue(undefined as any);
  controller.setMqttPublisher(publishSpy as any);
  const statusSpy = jest.fn().mockResolvedValue(undefined as any);
  controller.setStatusPublisher(statusSpy as any);
    const spy = jest.spyOn(httpClient, 'getJson').mockImplementation(async (url: string) => {
      if (url.endsWith('/brt.json')) return { brt: 55 };
      if (url.endsWith('/app.json')) return { theme: 3 };
      if (url.endsWith('/colon.json')) return { colon: 1 };
      if (url.endsWith('/hour12.json')) return { h: 0 };
      if (url.endsWith('/dst.json')) return { dst: 1 };
      return null;
    });

    await controller.loadDeviceState(device as any);
    const state = controller.getState(device.name);
    expect(state).toBeDefined();
  expect(state?.brt).toBe(55);
  expect(state?.theme).toBe(3);
  expect(state?.colon).toBe(1);
  expect(state?.hour12).toBe(0);
  expect(state?.dst).toBe(1);
  expect(publishSpy).toHaveBeenCalledWith(device.name, { brt: 55, theme: 3, colon: 1, hour12: 0, dst: 1 }, true);
  expect(statusSpy).toHaveBeenCalledWith(device.name, 'ONLINE', true);
    spy.mockRestore();
  });

  test('startStatePolling uses per-device polling intervals and initial load always occurs', async () => {
    const d1 = { name: 'tv1', type: 'smalltv-ultra', host: '192.168.1.50', polling: 1 };
    const d2 = { name: 'tv2', type: 'smalltv-ultra', host: '192.168.1.51', polling: 0 };
  const controller = new (require('../deviceController').default)([d1, d2], { pollIntervalSeconds: 30 });
  const publishSpy = jest.fn().mockResolvedValue(undefined as any);
  controller.setMqttPublisher(publishSpy as any);
  const statusSpy = jest.fn().mockResolvedValue(undefined as any);
  controller.setStatusPublisher(statusSpy as any);

    const spyGetJson = jest.spyOn(require('../httpClient'), 'getJson').mockResolvedValue({ brt: 10, theme: 1 });
    const spySetInterval = jest.spyOn(global as any, 'setInterval');

  await controller.startStatePolling();
    // initial all devices should be loaded
    expect(spyGetJson).toHaveBeenCalled();
    // setInterval should be set only for devices with polling > 0 (d1), so called once
    expect(spySetInterval).toHaveBeenCalled();

    controller.stopStatePolling();
    spyGetJson.mockRestore();
    spySetInterval.mockRestore();
    publishSpy.mockRestore && publishSpy.mockRestore();
  });

  test('startStatePolling publishes initial state for all topics on first load', async () => {
    const d1 = { name: 'tv1', type: 'smalltv-ultra', host: '192.168.1.50', polling: 1 };
    const d2 = { name: 'tv2', type: 'smalltv-ultra', host: '192.168.1.51', polling: 0 };
    const controller = new (require('../deviceController').default)([d1, d2], { pollIntervalSeconds: 30 });
  const publishSpy = jest.fn().mockResolvedValue(undefined as any);
  controller.setMqttPublisher(publishSpy as any);
  const statusSpy = jest.fn().mockResolvedValue(undefined as any);
  controller.setStatusPublisher(statusSpy as any);

    const spyGetJson = jest.spyOn(require('../httpClient'), 'getJson').mockImplementation(async (url: any) => {
      if (url.endsWith('/brt.json')) return { brt: 10 };
      if (url.endsWith('/app.json')) return { theme: 2 };
      if (url.endsWith('/colon.json')) return { colon: 1 };
      if (url.endsWith('/hour12.json')) return { h: 1 };
      if (url.endsWith('/dst.json')) return { dst: 0 };
      return null;
    });

    await controller.startStatePolling();

    expect(publishSpy).toHaveBeenCalledWith(d1.name, { brt: 10, theme: 2, colon: 1, hour12: 1, dst: 0 }, true);
    expect(publishSpy).toHaveBeenCalledWith(d2.name, { brt: 10, theme: 2, colon: 1, hour12: 1, dst: 0 }, true);

    controller.stopStatePolling();
    spyGetJson.mockRestore();
  });

  test('default polling uses verify.pollIntervalSeconds when device polling omitted', async () => {
    const d1 = { name: 'tv1', type: 'smalltv-ultra', host: '192.168.1.50' };
    const d2 = { name: 'tv2', type: 'smalltv-ultra', host: '192.168.1.51' };
    const verify = { pollIntervalSeconds: 5 };
  const controller = new (require('../deviceController').default)([d1, d2], verify as any);
  const publishSpy = jest.fn().mockResolvedValue(undefined as any);
  controller.setMqttPublisher(publishSpy as any);

    const spyGetJson = jest.spyOn(require('../httpClient'), 'getJson').mockResolvedValue({ brt: 10, theme: 1 });
    const spySetInterval = jest.spyOn(global as any, 'setInterval');

  await controller.startStatePolling();

    // setInterval should be called for both devices (2 calls) and interval parameter should be 5000
    expect(spySetInterval).toHaveBeenCalledTimes(2);
    for (const call of spySetInterval.mock.calls) {
      expect(call[1]).toBe(verify.pollIntervalSeconds * 1000);
    }

    controller.stopStatePolling();
    spyGetJson.mockRestore();
    spySetInterval.mockRestore();
    publishSpy.mockRestore && publishSpy.mockRestore();
  });

  test('publishes state changes across subsequent loads (colon example)', async () => {
    const controller = new (require('../deviceController').default)([device], {} as any);
  const publishSpy = jest.fn().mockResolvedValue(undefined as any);
  controller.setMqttPublisher(publishSpy as any);
  const statusSpy = jest.fn().mockResolvedValue(undefined as any);
  controller.setStatusPublisher(statusSpy as any);
    let colonCalls = 0;
  const spy = jest.spyOn(require('../httpClient'), 'getJson').mockImplementation(async (url: any) => {
      if (url.endsWith('/brt.json')) return { brt: 10 };
      if (url.endsWith('/app.json')) return { theme: 1 };
      if (url.endsWith('/colon.json')) {
        colonCalls += 1;
        return { colon: colonCalls === 1 ? 0 : 1 };
      }
      if (url.endsWith('/hour12.json')) return { h: 0 };
      if (url.endsWith('/dst.json')) return { dst: 0 };
      return null;
    });

  // First load should publish colon 0
  await controller.loadDeviceState(device as any);
  expect(controller.getState(device.name)?.colon).toBe(0);
  expect(publishSpy).toHaveBeenCalledWith(device.name, expect.objectContaining({ colon: 0 }), true);
    publishSpy.mockClear();
  // Second load should publish colon 1 (changed)
  await controller.loadDeviceState(device as any);
  expect(controller.getState(device.name)?.colon).toBe(1);
  expect(publishSpy).toHaveBeenCalledWith(device.name, expect.objectContaining({ colon: 1 }), true);
    spy.mockRestore();
  });

  test('loadDeviceState handles alternative JSON shapes', async () => {
    const controller = new (require('../deviceController').default)([device], {} as any);
  const publishSpy = jest.fn().mockResolvedValue(undefined as any);
  controller.setMqttPublisher(publishSpy as any);
  const statusSpy = jest.fn().mockResolvedValue(undefined as any);
  controller.setStatusPublisher(statusSpy as any);
    const spy = jest.spyOn(require('../httpClient'), 'getJson').mockImplementation(async (url: any) => {
      if (url.endsWith('/brt.json')) return { value: 55 };
      if (url.endsWith('/app.json')) return { app: { theme: 4 } };
      if (url.endsWith('/colon.json')) return { value: 1 };
      if (url.endsWith('/hour12.json')) return { value: 0 };
      if (url.endsWith('/dst.json')) return { value: 1 };
      return null;
    });

    await controller.loadDeviceState(device as any);
    const state = controller.getState(device.name);
    expect(state).toBeDefined();
    expect(state?.brt).toBe(55);
    expect(state?.theme).toBe(4);
    expect(state?.colon).toBe(1);
    expect(state?.hour12).toBe(0);
    expect(state?.dst).toBe(1);
    expect(publishSpy).toHaveBeenCalledWith(device.name, { brt: 55, theme: 4, colon: 1, hour12: 0, dst: 1 }, true);
    spy.mockRestore();
  });

  test('publishes defaults when keys missing (colon/dst/theme)', async () => {
    const controller = new (require('../deviceController').default)([device], {} as any);
  const publishSpy = jest.fn().mockResolvedValue(undefined as any);
  controller.setMqttPublisher(publishSpy as any);
  const statusSpy = jest.fn().mockResolvedValue(undefined as any);
  controller.setStatusPublisher(statusSpy as any);
    const spy = jest.spyOn(require('../httpClient'), 'getJson').mockImplementation(async (url: any) => {
      if (url.endsWith('/brt.json')) return { brt: 80 };
      if (url.endsWith('/hour12.json')) return { h: 1 };
      // colon.json, dst.json, app.json are absent
      return null;
    });

    await controller.loadDeviceState(device as any);
  expect(publishSpy).toHaveBeenCalledWith(device.name, { brt: 80, theme: 1, colon: 0, hour12: 1, dst: 0 }, true);
  expect(statusSpy).toHaveBeenCalledWith(device.name, 'ONLINE', true);
    spy.mockRestore();
  });
});
