import fs from 'fs';
import path from 'path';
import { loadConfig } from '../config';

describe('config loader', () => {
  test('parses array devices', () => {
    const filePath = path.resolve(__dirname, 'fixtures', 'config-array.yaml');
    const cfg = loadConfig(filePath);
    expect(cfg.devices).toBeInstanceOf(Array);
    expect(cfg.devices[0].name).toBe('lounge-tv');
    expect(cfg.devices[0].polling).toBe(30);
  });

  test('parses mapping devices', () => {
    const filePath = path.resolve(__dirname, 'fixtures', 'config-map.yaml');
    const cfg = loadConfig(filePath);
    expect(cfg.devices).toBeInstanceOf(Array);
    expect(cfg.devices[0].name).toBe('lounge-tv');
    expect(cfg.devices[0].polling).toBe(30);
  });

  test('invalid array missing name throws', () => {
    const filePath = path.resolve(__dirname, 'fixtures', 'invalid-array-missing-name.yaml');
    expect(() => loadConfig(filePath)).toThrow(/devices array/);
  });

  test('invalid map missing host throws', () => {
    const filePath = path.resolve(__dirname, 'fixtures', 'invalid-map-missing-ip.yaml');
    expect(() => loadConfig(filePath)).toThrow(/must include type and host/);
  });

  test('duplicate device names throw', () => {
    const filePath = path.resolve(__dirname, 'fixtures', 'invalid-duplicate-array.yaml');
    expect(() => loadConfig(filePath)).toThrow(/Duplicate device names/);
  });

  test('invalid map negative polling throws', () => {
    const filePath = path.resolve(__dirname, 'fixtures', 'invalid-map-neg-poll.yaml');
    expect(() => loadConfig(filePath)).toThrow(/polling must be a non-negative number/);
  });

  test('parses array devices with host field', () => {
    const filePath = path.resolve(__dirname, 'fixtures', 'config-array-ip.yaml');
    const cfg = loadConfig(filePath);
    expect(cfg.devices).toBeInstanceOf(Array);
    expect(cfg.devices[0].name).toBe('lounge-tv');
    expect(cfg.devices[0].host).toBe('192.168.1.50');
  });

  test('parses mapping devices with host field', () => {
    const filePath = path.resolve(__dirname, 'fixtures', 'config-map-ip.yaml');
    const cfg = loadConfig(filePath);
    expect(cfg.devices).toBeInstanceOf(Array);
    expect(cfg.devices[0].name).toBe('lounge-tv');
    expect(cfg.devices[0].host).toBe('192.168.1.50');
  });

  test('parses mapping devices with image config preserved', () => {
    const filePath = path.resolve(__dirname, 'fixtures', 'config-map-image.yaml');
    const cfg = loadConfig(filePath);
    expect(cfg.devices[0].image).toBeDefined();
    expect(cfg.devices[0].image?.flip?.vertical).toBe(true);
    expect(cfg.devices[0].image?.rotate).toBe(90);
  });

  test('parses array devices with image config preserved', () => {
    const filePath = path.resolve(__dirname, 'fixtures', 'config-array-image.yaml');
    const cfg = loadConfig(filePath);
    expect(cfg.devices[0].image).toBeDefined();
    expect(cfg.devices[0].image?.flip?.vertical).toBe(true);
    expect(cfg.devices[0].image?.rotate).toBe(90);
  });

  test('MQTT_PASSWORD env overrides YAML password', () => {
    const filePath = path.resolve(__dirname, 'fixtures', 'config-map.yaml');
    const original = process.env.MQTT_PASSWORD;
    try {
      process.env.MQTT_PASSWORD = 'env-secret';
      const cfg = loadConfig(filePath);
      expect(cfg.mqtt.password).toBe('env-secret');
    } finally {
      if (original === undefined) delete process.env.MQTT_PASSWORD; else process.env.MQTT_PASSWORD = original;
    }
  });

  test('MQTT_PASSWORD_FILE env overrides YAML and MQTT_PASSWORD', () => {
    const filePath = path.resolve(__dirname, 'fixtures', 'config-map.yaml');
    const tmpFile = path.resolve(__dirname, 'fixtures', 'mqtt-secret.txt');
    const originalPassword = process.env.MQTT_PASSWORD;
    const originalPasswordFile = process.env.MQTT_PASSWORD_FILE;
    try {
      fs.writeFileSync(tmpFile, 'file-secret', 'utf8');
      process.env.MQTT_PASSWORD = 'env-secret';
      process.env.MQTT_PASSWORD_FILE = tmpFile;
      const cfg = loadConfig(filePath);
      expect(cfg.mqtt.password).toBe('file-secret');
    } finally {
      fs.existsSync(tmpFile) && fs.unlinkSync(tmpFile);
      if (originalPassword === undefined) delete process.env.MQTT_PASSWORD; else process.env.MQTT_PASSWORD = originalPassword;
      if (originalPasswordFile === undefined) delete process.env.MQTT_PASSWORD_FILE; else process.env.MQTT_PASSWORD_FILE = originalPasswordFile;
    }
  });

  test('MQTT_PASSWORD_FILE env throws when file missing', () => {
    const filePath = path.resolve(__dirname, 'fixtures', 'config-map.yaml');
    const originalPasswordFile = process.env.MQTT_PASSWORD_FILE;
    try {
      process.env.MQTT_PASSWORD_FILE = '/tmp/does-not-exist-secret.txt';
      expect(() => loadConfig(filePath)).toThrow(/MQTT_PASSWORD_FILE is set but file not found/);
    } finally {
      if (originalPasswordFile === undefined) delete process.env.MQTT_PASSWORD_FILE; else process.env.MQTT_PASSWORD_FILE = originalPasswordFile;
    }
  });
});
