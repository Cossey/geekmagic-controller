import DeviceController from '../deviceController';
import * as httpClient from '../httpClient';
import Jimp from 'jimp';

// Image operations can be slightly slow on CI; raise timeout for this file
jest.setTimeout(10000);

const device = { name: 'lounge-tv', type: 'smalltv-ultra', host: '192.168.1.50' } as any;

describe('DeviceController IMAGE handling', () => {
  test('uploads image and sets theme to 3', async () => {
    const controller = new DeviceController([device], { afterCommand: false });
    const publishSpy = jest.fn().mockResolvedValue(undefined as any);
    controller.setMqttPublisher(publishSpy as any);

  const uploadMock = jest.fn().mockResolvedValue(true as any);
  controller.imageUploader = uploadMock;
  controller.sendGetFn = jest.fn().mockResolvedValue(null as any);

    // Create a test image 480x480
    const img = await new Jimp(480, 480, 0xff0000ff); // red
    const dataUri = await img.getBase64Async(Jimp.MIME_PNG);

    await controller.handleCommand(device.name, 'IMAGE', dataUri);

  expect((controller as any).imageUploader).toHaveBeenCalled();
  expect((controller as any).sendGetFn).toHaveBeenCalledWith('http://192.168.1.50/set?theme=3');
  expect((controller as any).sendGetFn).toHaveBeenCalledWith('http://192.168.1.50/set?img=%2Fimage%2F%2Fupload.jpg');
    expect(publishSpy).toHaveBeenCalledWith(device.name, { theme: 3 }, true);

    controller.imageUploader = undefined;
    controller.sendGetFn = undefined;
  });

  test('crop top-right for oversize images', async () => {
    const d = { ...device, image: { oversize: 'crop', cropposition: 'topright' } } as any;
    const controller = new DeviceController([d], { afterCommand: false });
    const publishSpy = jest.fn().mockResolvedValue(undefined as any);
    controller.setMqttPublisher(publishSpy as any);

    // Create 480x480 image with top-right quadrant blue
    const img = await new Jimp(480, 480, 0xffffffff);
    // top-left red
    img.scan(0, 0, 240, 240, function (this: any, x: number, y: number, idx: number) {
      this.bitmap.data[idx + 0] = 255; // r
      this.bitmap.data[idx + 1] = 0; // g
      this.bitmap.data[idx + 2] = 0; // b
    });
    // top-right blue
    img.scan(240, 0, 240, 240, function (this: any, x: number, y: number, idx: number) {
      this.bitmap.data[idx + 0] = 0;
      this.bitmap.data[idx + 1] = 0;
      this.bitmap.data[idx + 2] = 255;
    });

    const dataUri = await img.getBase64Async(Jimp.MIME_PNG);

    let captured: Buffer | null = null;
    const origGet = (httpClient as any).sendGet;
    let capturedFilename: string | undefined;
    let capturedContentType: string | undefined;
    const uploadMock = jest.fn().mockImplementation(async (_d: any, buf: Buffer, filename: string, contentType: string) => {
      captured = buf;
      capturedFilename = filename;
      capturedContentType = contentType;
      return true;
    });
    controller.imageUploader = uploadMock;
    controller.sendGetFn = jest.fn().mockResolvedValue(null as any);

    await controller.handleCommand(d.name, 'IMAGE', dataUri);

    expect(captured).not.toBeNull();
  const out = await Jimp.read(captured! as Buffer);
    expect(out.getWidth()).toBe(240);
    expect(out.getHeight()).toBe(240);
    // top-left pixel should be blue (top-right area of original cropped to top-left of result)
    const c = out.getPixelColor(0, 0);
    const rgba = Jimp.intToRGBA(c);
    expect(rgba.b).toBeGreaterThan(200);
    expect(capturedFilename).toBe('upload.jpg');
    expect(capturedContentType).toBe('image/jpeg');

  controller.imageUploader = undefined;
  controller.sendGetFn = undefined;
  });

  test('resize smaller images to 240x240', async () => {
    const d = { ...device, image: { oversize: 'resize' } } as any;
    const controller = new DeviceController([d], { afterCommand: false });
    const publishSpy = jest.fn().mockResolvedValue(undefined as any);
    controller.setMqttPublisher(publishSpy as any);

    // Create small image 100x50 (will be resized to fit in 240x240 and padded)
    const img = await new Jimp(100, 50, 0x00ff00ff);
    const dataUri = await img.getBase64Async(Jimp.MIME_PNG);

    let captured: Buffer | null = null;
    const origGet = (httpClient as any).sendGet;
    let capturedFilename: string | undefined;
    let capturedContentType: string | undefined;
    const uploadMock = jest.fn().mockImplementation(async (_d: any, buf: Buffer, filename: string, contentType: string) => {
      captured = buf;
      capturedFilename = filename;
      capturedContentType = contentType;
      return true;
    });
    controller.imageUploader = uploadMock;
    controller.sendGetFn = jest.fn().mockResolvedValue(null as any);

    await controller.handleCommand(d.name, 'IMAGE', dataUri);
    expect(captured).not.toBeNull();
  const out = await Jimp.read(captured! as Buffer);
    expect(out.getWidth()).toBe(240);
    expect(out.getHeight()).toBe(240);
  expect(capturedFilename).toBe('upload.jpg');
  expect(capturedContentType).toBe('image/jpeg');

  controller.imageUploader = undefined;
  controller.sendGetFn = undefined;
  });

  test('IMAGE with verification enabled publishes after verification', async () => {
    const controller = new DeviceController([device], { afterCommand: true, retries: 1, initialDelayMs: 1, backoffMs: 1 } as any);
    const publishSpy = jest.fn().mockResolvedValue(undefined as any);
    controller.setMqttPublisher(publishSpy as any);

    const img = await new Jimp(300, 300, 0xabcdefff);
    const dataUri = await img.getBase64Async(Jimp.MIME_PNG);

  const uploadMock = jest.fn().mockResolvedValue(true);
  controller.imageUploader = uploadMock;
    controller.sendGetFn = jest.fn().mockResolvedValue(null as any);

    const spyGetJson = jest.spyOn(httpClient, 'getJson').mockResolvedValue({ theme: 3 } as any);

    await controller.handleCommand(device.name, 'IMAGE', dataUri);

    expect(uploadMock).toHaveBeenCalled();
    // verification should have resulted in a publish for theme
    expect(publishSpy).toHaveBeenCalledWith(device.name, { theme: 3 }, true);

    spyGetJson.mockRestore();
    controller.imageUploader = undefined;
    controller.sendGetFn = undefined;
  });

  test('declared GIF but actual PNG buffer is converted to JPG', async () => {
    const controller = new DeviceController([device], { afterCommand: false });
    let capturedBuf: Buffer | null = null;
    let capturedFilename: string | undefined;
    let capturedContentType: string | undefined;
    const uploadMock = jest.fn().mockImplementation(async (_d: any, buf: Buffer, filename: string, contentType: string) => {
      capturedBuf = buf;
      capturedFilename = filename;
      capturedContentType = contentType;
      return true;
    });
    controller.imageUploader = uploadMock;
    controller.sendGetFn = jest.fn().mockResolvedValue(null as any);

    // create 240x240 image but pretend it's a GIF via data URI mime
    const img = await new Jimp(240, 240, 0x112233ff);
    const pngBuf = await img.getBufferAsync(Jimp.MIME_PNG);
    const dataUri = `data:image/gif;base64,${pngBuf.toString('base64')}`;

    await controller.handleCommand(device.name, 'IMAGE', dataUri);

    expect(capturedFilename).toBe('upload.jpg');
    expect(capturedContentType).toBe('image/jpeg');
  });

  test('resize GIF input and upload as GIF (animation preserved)', async () => {
    const controller = new DeviceController([device], { afterCommand: false });
    let capturedBuf: Buffer | null = null;
    let capturedFilename: string | undefined;
    let capturedContentType: string | undefined;
    const uploadMock = jest.fn().mockImplementation(async (_d: any, buf: Buffer, filename: string, contentType: string) => {
      capturedBuf = buf;
      capturedFilename = filename;
      capturedContentType = contentType;
      return true;
    });
    controller.imageUploader = uploadMock;
    controller.sendGetFn = jest.fn().mockResolvedValue(null as any);

    // create a 480x480 PNG and convert it to a GIF buffer (single-frame GIF)
    const img = await new Jimp(480, 480, 0x445566ff);
    const png = await img.getBufferAsync(Jimp.MIME_PNG);
    const gifBuf = await require('sharp')(png).gif().toBuffer();
    const dataUri = `data:image/gif;base64,${gifBuf.toString('base64')}`;

    await controller.handleCommand(device.name, 'IMAGE', dataUri);

    expect(capturedFilename).toBe('upload.gif');
    expect(capturedContentType).toBe('image/gif');
    expect(capturedBuf).not.toBeNull();
    // confirm buffer starts with GIF header
    expect(capturedBuf!.slice(0, 3).toString('ascii')).toBe('GIF');
  });
});
