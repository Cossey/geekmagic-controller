import DeviceController from '../deviceController';

const device = { name: 'lounge-tv', type: 'smalltv-ultra', host: '192.168.1.50' };

describe('DeviceController ranges', () => {
  const controller = new DeviceController([device]);

  test('builds THEME url', () => {
    const url = controller.buildCommandUrl(device, 'THEME', '3');
    expect(url).toBe('http://192.168.1.50/set?theme=3');
  });

  test('theme lower bound 1 valid', () => {
    const url = controller.buildCommandUrl(device, 'THEME', '1');
    expect(url).toBe('http://192.168.1.50/set?theme=1');
  });

  test('theme upper bound 7 valid', () => {
    const url = controller.buildCommandUrl(device, 'THEME', '7');
    expect(url).toBe('http://192.168.1.50/set?theme=7');
  });

  test('theme 0 invalid', () => {
    const url = controller.buildCommandUrl(device, 'THEME', '0');
    expect(url).toBeNull();
  });

  test('theme 8 invalid', () => {
    const url = controller.buildCommandUrl(device, 'THEME', '8');
    expect(url).toBeNull();
  });

  test('theme decimal invalid', () => {
    const url = controller.buildCommandUrl(device, 'THEME', '2.5');
    expect(url).toBeNull();
  });

  test('builds BRIGHTNESS url', () => {
    const url = controller.buildCommandUrl(device, 'BRIGHTNESS', '55');
    expect(url).toBe('http://192.168.1.50/set?brt=55');
  });

  test('brightness lower bound 0 valid', () => {
    const url = controller.buildCommandUrl(device, 'BRIGHTNESS', '0');
    expect(url).toBe('http://192.168.1.50/set?brt=0');
  });

  test('brightness upper bound 100 valid', () => {
    const url = controller.buildCommandUrl(device, 'BRIGHTNESS', '100');
    expect(url).toBe('http://192.168.1.50/set?brt=100');
  });

  test('brightness -1 invalid', () => {
    const url = controller.buildCommandUrl(device, 'BRIGHTNESS', '-1');
    expect(url).toBeNull();
  });

  test('brightness 101 invalid', () => {
    const url = controller.buildCommandUrl(device, 'BRIGHTNESS', '101');
    expect(url).toBeNull();
  });

  test('brightness decimal invalid', () => {
    const url = controller.buildCommandUrl(device, 'BRIGHTNESS', '50.5');
    expect(url).toBeNull();
  });

  test('builds COMMAND REBOOT url', () => {
    const url = controller.buildCommandUrl(device, 'COMMAND', 'REBOOT');
    expect(url).toBe('http://192.168.1.50/set?reboot=1');
  });

  test('builds COLONBLINK url with YES', () => {
    const url = controller.buildCommandUrl(device, 'COLONBLINK', 'YES');
    expect(url).toBe('http://192.168.1.50/set?colon=1');
  });

  test('builds COLONBLINK url with 0', () => {
    const url = controller.buildCommandUrl(device, 'COLONBLINK', '0');
    expect(url).toBe('http://192.168.1.50/set?colon=0');
  });

  test('invalid COLONBLINK values return null', () => {
    expect(controller.buildCommandUrl(device, 'COLONBLINK', '2')).toBeNull();
    expect(controller.buildCommandUrl(device, 'COLONBLINK', 'maybe')).toBeNull();
  });

  test('builds 12HOUR url with NO', () => {
    const url = controller.buildCommandUrl(device, '12HOUR', 'NO');
    expect(url).toBe('http://192.168.1.50/set?hour=0');
  });

  test('builds 12HOUR url with 1', () => {
    const url = controller.buildCommandUrl(device, '12HOUR', '1');
    expect(url).toBe('http://192.168.1.50/set?hour=1');
  });

  test('invalid 12HOUR values return null', () => {
    expect(controller.buildCommandUrl(device, '12HOUR', '2')).toBeNull();
  });

  test('builds DST url with YES', () => {
    const url = controller.buildCommandUrl(device, 'DST', 'YES');
    expect(url).toBe('http://192.168.1.50/set?dst=1');
  });

  test('builds DST url with 0', () => {
    const url = controller.buildCommandUrl(device, 'DST', '0');
    expect(url).toBe('http://192.168.1.50/set?dst=0');
  });

  test('invalid DST values return null', () => {
    expect(controller.buildCommandUrl(device, 'DST', '2')).toBeNull();
  });
});
