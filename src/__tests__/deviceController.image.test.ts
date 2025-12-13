import DeviceController from '../deviceController';
import * as httpClient from '../httpClient';
import Jimp from 'jimp';
import { buildSvgForText } from '../deviceController';

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
  // Simulate device accepting theme and image selection
  controller.sendGetFn = jest.fn().mockImplementation(async (url: string) => {
    if (url.includes('/set?theme=')) return { status: 200 } as any;
    if (url.includes('/set?img=')) return { status: 200 } as any;
    return { status: 200 } as any;
  });

    // Create a test image 480x480
    const img = await new Jimp(480, 480, 0xff0000ff); // red
    const dataUri = await img.getBase64Async(Jimp.MIME_PNG);

    await controller.handleCommand(device.name, 'IMAGE', dataUri);

  expect((controller as any).imageUploader).toHaveBeenCalled();
  expect((controller as any).sendGetFn).toHaveBeenCalledWith('http://192.168.1.50/set?theme=3');
  expect((controller as any).sendGetFn.mock.calls.some((c: any[]) => c[0].includes('/set?img='))).toBeTruthy();
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

  test('generate image from text and upload', async () => {
    const controller = new DeviceController([device], { afterCommand: false });
    let captured: Buffer | null = null;
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

  const logSpy = jest.spyOn(console, 'log');

    await controller.generateAndUploadImage(device.name, { text: 'Hello World' });

    expect(captured).not.toBeNull();
    const out = await Jimp.read(captured!);
    expect(out.getWidth()).toBe(240);
    expect(out.getHeight()).toBe(240);
    // top-left should be near black background
    const c = out.getPixelColor(0, 0);
    const rgba = Jimp.intToRGBA(c);
    expect(rgba.r).toBeLessThan(20);
    expect(capturedFilename).toBe('upload.jpg');
    expect(capturedContentType).toBe('image/jpeg');
  expect(logSpy.mock.calls.some((c: any[]) => c.join(' ').includes('IMAGE/GENERATE rendering'))).toBeTruthy();
  expect(logSpy.mock.calls.some((c: any[]) => c.join(' ').includes('IMAGE/GENERATE uploading'))).toBeTruthy();
    logSpy.mockRestore();
    controller.imageUploader = undefined;
    controller.sendGetFn = undefined;
  });

  test('generate image sets theme and selects image when HTTP returns 200', async () => {
    const controller = new DeviceController([device], { afterCommand: false });
    const uploadMock = jest.fn().mockResolvedValue(true);
    controller.imageUploader = uploadMock;
    const sendGetMock = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/set?img=')) return { status: 200 } as any;
      if (url.includes('/set?theme=')) return { status: 200 } as any;
      return { status: 200 } as any;
    });
    controller.sendGetFn = sendGetMock;

    const ok = await controller.generateAndUploadImage(device.name, { text: 'Hi there' });
    expect(ok).toBe(true);
    // sendGet should have been called for img and theme
    expect(sendGetMock.mock.calls.some((c: any[]) => c[0].includes('/set?img='))).toBeTruthy();
    expect(sendGetMock.mock.calls.some((c: any[]) => c[0].includes('/set?theme=3'))).toBeTruthy();
    // state should be updated to theme=3
    const state = controller.getState(device.name);
    expect(state?.theme).toBe(3);

    controller.imageUploader = undefined;
    controller.sendGetFn = undefined;
  });

  test('generate marks device OFFLINE when selection fails', async () => {
    const controller = new DeviceController([device], { afterCommand: false });
    const uploadMock = jest.fn().mockResolvedValue(true);
    controller.imageUploader = uploadMock;
    const statusSpy = jest.fn().mockResolvedValue(undefined as any);
    controller.setStatusPublisher(statusSpy as any);
    controller.sendGetFn = jest.fn().mockResolvedValue(null as any);

    const ok = await controller.generateAndUploadImage(device.name, { text: 'Hello offline' });
    expect(ok).toBe(false);
    expect(statusSpy).toHaveBeenCalledWith(device.name, 'OFFLINE', true);
    controller.imageUploader = undefined;
    controller.sendGetFn = undefined;
  });

  test('generate image falls back to unencoded path when encoded fails', async () => {
    const controller = new DeviceController([device], { afterCommand: false });
    const uploadMock = jest.fn().mockResolvedValue(true);
    controller.imageUploader = uploadMock;
    const sendGetMock = jest.fn().mockImplementation(async (url: string) => {
      // encoded double-slash fails
      if (url.includes('%2Fimage%2F%2Fupload.jpg')) return null as any;
      // unencoded path succeeds
      if (url.includes('/set?img=/image/upload.jpg')) return { status: 200 } as any;
      if (url.includes('/set?theme=')) return { status: 200 } as any;
      return null as any;
    });
    controller.sendGetFn = sendGetMock;

    const ok = await controller.generateAndUploadImage(device.name, { text: 'Fallback test' });
    expect(ok).toBe(true);
  // Accept any img selection attempt variant and that theme was set
  expect(sendGetMock.mock.calls.some((c: any[]) => c[0].includes('/set?img='))).toBeTruthy();
  expect(sendGetMock.mock.calls.some((c: any[]) => c[0].includes('/set?theme=3'))).toBeTruthy();
    const state = controller.getState(device.name);
    expect(state?.theme).toBe(3);

    controller.imageUploader = undefined;
    controller.sendGetFn = undefined;
  });

  test('generate selects image before setting theme', async () => {
    const controller = new DeviceController([device], { afterCommand: false });
    const uploadMock = jest.fn().mockResolvedValue(true);
    controller.imageUploader = uploadMock;
    const calls: string[] = [];
    controller.sendGetFn = jest.fn().mockImplementation(async (url: string) => {
      calls.push(url);
      if (url.includes('/set?img=')) return { status: 200 } as any;
      if (url.includes('/set?theme=')) return { status: 200 } as any;
      return { status: 200 } as any;
    });

    const ok = await controller.generateAndUploadImage(device.name, { text: 'Order test' });
    expect(ok).toBe(true);
    const firstImg = calls.findIndex((u) => u.includes('/set?img='));
    const firstTheme = calls.findIndex((u) => u.includes('/set?theme='));
    expect(firstImg).toBeGreaterThanOrEqual(0);
    expect(firstTheme).toBeGreaterThanOrEqual(0);
    expect(firstImg < firstTheme).toBeTruthy();

    controller.imageUploader = undefined;
    controller.sendGetFn = undefined;
  });

  test('IMAGE selects image before setting theme', async () => {
    const controller = new DeviceController([device], { afterCommand: false });
    const uploadMock = jest.fn().mockResolvedValue(true);
    controller.imageUploader = uploadMock;
    const calls: string[] = [];
    controller.sendGetFn = jest.fn().mockImplementation(async (url: string) => {
      calls.push(url);
      if (url.includes('/set?img=')) return { status: 200 } as any;
      if (url.includes('/set?theme=')) return { status: 200 } as any;
      return { status: 200 } as any;
    });

    const img = await new Jimp(240, 240, 0xff0000ff);
    const dataUri = await img.getBase64Async(Jimp.MIME_PNG);
    await controller.handleCommand(device.name, 'IMAGE', dataUri);

    const firstImg = calls.findIndex((u) => u.includes('/set?img='));
    const firstTheme = calls.findIndex((u) => u.includes('/set?theme='));
    expect(firstImg).toBeGreaterThanOrEqual(0);
    expect(firstTheme).toBeGreaterThanOrEqual(0);
    expect(firstImg < firstTheme).toBeTruthy();

    controller.imageUploader = undefined;
    controller.sendGetFn = undefined;
  });

  test('generate with markup and inline image', async () => {
    const controller = new DeviceController([device], { afterCommand: false });
    let captured: Buffer | null = null;
    const uploadMock = jest.fn().mockImplementation(async (_d: any, buf: Buffer, filename: string) => {
      captured = buf;
      return true;
    });
    controller.imageUploader = uploadMock;
    controller.sendGetFn = jest.fn().mockResolvedValue(null as any);

  const logSpy = jest.spyOn(console, 'log');

    // create small inline image
    const icon = await new Jimp(32, 32, 0x0000ffff);
    const iconData = (await icon.getBufferAsync(Jimp.MIME_PNG)).toString('base64');
    const dataUri = `data:image/png;base64,${iconData}`;

    const markup = `Line1 [color=#ff0000]Red[/color]\nIcon below\n[img:${dataUri}]`;
    await controller.generateAndUploadImage(device.name, { text: markup });

    expect(captured).not.toBeNull();
    const out = await Jimp.read(captured!);
    expect(out.getWidth()).toBe(240);
    expect(out.getHeight()).toBe(240);
  expect(logSpy.mock.calls.some((c: any[]) => c.join(' ').includes('IMAGE/GENERATE rendering'))).toBeTruthy();
  expect(logSpy.mock.calls.some((c: any[]) => c.join(' ').includes('IMAGE/GENERATE uploading'))).toBeTruthy();
    logSpy.mockRestore();
    controller.imageUploader = undefined;
    controller.sendGetFn = undefined;
  });

  test('generate image publishes status events', async () => {
    const controller = new DeviceController([device], { afterCommand: false });
    const uploadMock = jest.fn().mockResolvedValue(true);
    controller.imageUploader = uploadMock;
    const sendGetMock = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/set?img=')) return { status: 200 } as any;
      if (url.includes('/set?theme=')) return { status: 200 } as any;
      return { status: 200 } as any;
    });
    controller.sendGetFn = sendGetMock;

    const statusSpy = jest.fn().mockResolvedValue(undefined as any);
    controller.setImageStatusPublisher(statusSpy as any);

    const ok = await controller.generateAndUploadImage(device.name, { text: 'Status test' });
    expect(ok).toBe(true);
    expect(statusSpy).toHaveBeenCalled();
    // Expect rendering, uploaded, selecting and done stages to have been published
    expect(statusSpy.mock.calls.some((c: any[]) => c[1].includes('"stage":"rendering"'))).toBeTruthy();
    expect(statusSpy.mock.calls.some((c: any[]) => c[1].includes('"stage":"uploaded"'))).toBeTruthy();
    expect(statusSpy.mock.calls.some((c: any[]) => c[1].includes('"stage":"selecting"'))).toBeTruthy();
    expect(statusSpy.mock.calls.some((c: any[]) => c[1].includes('"stage":"done"'))).toBeTruthy();

    controller.imageUploader = undefined;
    controller.sendGetFn = undefined;
  });

  test('IMAGE upload publishes status events', async () => {
    const controller = new DeviceController([device], { afterCommand: false });
    const statusSpy = jest.fn().mockResolvedValue(undefined as any);
    controller.setImageStatusPublisher(statusSpy as any);

    const uploadMock = jest.fn().mockResolvedValue(true);
    controller.imageUploader = uploadMock;
    controller.sendGetFn = jest.fn().mockImplementation(async (url: string) => ({ status: 200 } as any));

    // Create a test image 240x240
    const img = await new Jimp(240, 240, 0xff0000ff); // red
    const dataUri = await img.getBase64Async(Jimp.MIME_PNG);

    await controller.handleCommand(device.name, 'IMAGE', dataUri);
    expect(statusSpy).toHaveBeenCalled();
    expect(statusSpy.mock.calls.some((c: any[]) => c[1].includes('"stage":"uploading"'))).toBeTruthy();
    expect(statusSpy.mock.calls.some((c: any[]) => c[1].includes('"stage":"uploaded"'))).toBeTruthy();
    expect(statusSpy.mock.calls.some((c: any[]) => c[1].includes('"stage":"selecting"'))).toBeTruthy();
    expect(statusSpy.mock.calls.some((c: any[]) => c[1].includes('"stage":"done"'))).toBeTruthy();

    controller.imageUploader = undefined;
    controller.sendGetFn = undefined;
  });

  test('buildSvgForText preserves explicit newlines', () => {
    const svgObj = buildSvgForText('Line1\nLine2', '#000000', '#ffffff', 28);
    // Should produce at least two <text ...> lines for the two lines
    const textCount = (svgObj.svg.match(/<text\s/gi) || []).length;
    expect(textCount).toBeGreaterThanOrEqual(2);
  });

  test('buildSvgForText preserves multiple spaces', () => {
    const svgObj = buildSvgForText('A  B', '#000000', '#ffffff', 28);
    // xml:space should be present and double space preserved in the SVG text
    expect(svgObj.svg.includes('xml:space="preserve"')).toBeTruthy();
    // Check that a tspan exists which contains two spaces
    expect(/<tspan[^>]*>\s{2}<\/tspan>/.test(svgObj.svg)).toBeTruthy();
  });

  test('buildSvgForText halign left and right', () => {
    const leftSvg = buildSvgForText('Left', '#000000', '#ffffff', 28, { halign: 'left' });
    expect(leftSvg.svg.includes('text-anchor="start"')).toBeTruthy();
    expect(leftSvg.svg.includes('x="4"')).toBeTruthy();
    const rightSvg = buildSvgForText('Right', '#000000', '#ffffff', 28, { halign: 'right' });
    expect(rightSvg.svg.includes('text-anchor="end"')).toBeTruthy();
    // right alignment should position x at width-margin
    expect(rightSvg.svg.includes('x="236"')).toBeTruthy();
  });

  test('buildSvgForText valign top and bottom', () => {
    const top = buildSvgForText('Line1\nLine2', '#000000', '#ffffff', 28, { valign: 'top' });
    const bottom = buildSvgForText('Line1\nLine2', '#000000', '#ffffff', 28, { valign: 'bottom' });
    // Extract first text y values and compare
    const re = /<text[^>]* y="([0-9.]+)"/g;
    const topMatch = re.exec(top.svg);
    const bottomMatch = re.exec(bottom.svg);
    // exec returns array where [1] is y value
    expect(topMatch).not.toBeNull();
    expect(bottomMatch).not.toBeNull();
    const topY = Number((topMatch as any)[1]);
    const bottomY = Number((bottomMatch as any)[1]);
    // topY should be less than bottomY, as top alignment should place first line nearer to the top
    expect(topY).toBeLessThan(bottomY);
  });

  test('buildSvgForText prefers DejaVu Sans font-family', () => {
    const svgObj = buildSvgForText('Hello', '#000000', '#ffffff', 28);
    expect(svgObj.svg.includes('font-family="DejaVu Sans, Arial, sans-serif"')).toBeTruthy();
  });

  test('buildSvgForText halign left/right/center respects hmargin', () => {
    const left = buildSvgForText('Left', '#000000', '#ffffff', 28, { halign: 'left', hmargin: 12 });
    expect(left.svg.includes('text-anchor="start"')).toBeTruthy();
    expect(left.svg.includes('x="12"')).toBeTruthy();

    const right = buildSvgForText('Right', '#000000', '#ffffff', 28, { halign: 'right', hmargin: 18 });
    expect(right.svg.includes('text-anchor="end"')).toBeTruthy();
    expect(right.svg.includes('x="222"')).toBeTruthy(); // 240 - 18 = 222

    const center = buildSvgForText('Center', '#000000', '#ffffff', 28, { halign: 'center', hmargin: 10 });
    // center x is 120 + hmargin
    expect(center.svg.includes('x="130"')).toBeTruthy();
  });

  test('buildSvgForText valign top/center/bottom respects vmargin (differences)', () => {
    const top1 = buildSvgForText('A', '#000000', '#ffffff', 28, { valign: 'top', vmargin: 20 });
    const top2 = buildSvgForText('A', '#000000', '#ffffff', 28, { valign: 'top', vmargin: 30 });
    const re = /<text[^>]* y="([0-9.]+)"/g;
    const y1 = Number(re.exec(top1.svg)?.[1] || '0');
    re.lastIndex = 0;
    const y2 = Number(re.exec(top2.svg)?.[1] || '0');
    expect(Math.round(y2 - y1)).toBe(10);

    const center1 = buildSvgForText('B', '#000000', '#ffffff', 28, { valign: 'center', vmargin: 5 });
    const center2 = buildSvgForText('B', '#000000', '#ffffff', 28, { valign: 'center', vmargin: 15 });
    const reC = /<text[^>]* y="([0-9.]+)"/g;
    const cy1 = Number(reC.exec(center1.svg)?.[1] || '0');
    reC.lastIndex = 0;
    const cy2 = Number(reC.exec(center2.svg)?.[1] || '0');
    expect(Math.round(cy2 - cy1)).toBe(10);

    const bottom1 = buildSvgForText('C', '#000000', '#ffffff', 28, { valign: 'bottom', vmargin: 8 });
    const bottom2 = buildSvgForText('C', '#000000', '#ffffff', 28, { valign: 'bottom', vmargin: 18 });
    const reB = /<text[^>]* y="([0-9.]+)"/g;
    const by1 = Number(reB.exec(bottom1.svg)?.[1] || '0');
    reB.lastIndex = 0;
    const by2 = Number(reB.exec(bottom2.svg)?.[1] || '0');
  expect(Math.round(by2 - by1)).toBe(-10); // increasing bottom margin should move the baseline upward by 10 (negative shift)
  });

  test('generateAndUploadImage passes halign/valign to buildSvgForText', async () => {
    const devmod = await import('../deviceController');
    const controller = new devmod.default([device], { afterCommand: false });
    const uploadMock = jest.fn().mockResolvedValue(true);
    controller.imageUploader = uploadMock;
    const spy = jest.spyOn(devmod, 'buildSvgForText');
    controller.sendGetFn = jest.fn().mockResolvedValue({ status: 200 } as any);
  await controller.generateAndUploadImage(device.name, { text: 'Test', halign: 'left', valign: 'top', hmargin: 12, vmargin: 6 });
    expect(spy).toHaveBeenCalled();
    const args = spy.mock.calls[spy.mock.calls.length - 1];
    expect(args[0]).toBe('Test');
  expect(args[4]).toEqual(expect.objectContaining({ halign: 'left', valign: 'top' }));
  // margins are present in the options argument
  expect((args[4] as any).hmargin).toBe(12);
  expect((args[4] as any).vmargin).toBe(6);
    spy.mockRestore();
    controller.imageUploader = undefined;
    controller.sendGetFn = undefined;
  });

  test('generate image with unicode characters renders text', async () => {
    const controller = new DeviceController([device], { afterCommand: false });
    let captured: Buffer | null = null;
    const uploadMock = jest.fn().mockImplementation(async (_d: any, buf: Buffer, filename: string) => {
      captured = buf;
      return true;
    });
    controller.imageUploader = uploadMock;
    controller.sendGetFn = jest.fn().mockResolvedValue({ status: 200 } as any);

    // Use em-dash and some non-ascii glyphs as a stress test for fonts
    const text = 'Café — Hello — 世界';
    await controller.generateAndUploadImage(device.name, { text });

    expect(captured).not.toBeNull();
    const out = await Jimp.read(captured!);
    expect(out.getWidth()).toBe(240);
    expect(out.getHeight()).toBe(240);
    // search a small center area for any non-background pixel (not pure black)
    const found = (() => {
      const cx = Math.floor(out.getWidth() / 2);
      const cy = Math.floor(out.getHeight() / 2);
      for (let dx = -8; dx <= 8; dx++) {
        for (let dy = -8; dy <= 8; dy++) {
          const px = cx + dx;
          const py = cy + dy;
          if (px < 0 || py < 0 || px >= out.getWidth() || py >= out.getHeight()) continue;
          const c = out.getPixelColor(px, py);
          const rgba = Jimp.intToRGBA(c);
          // white text has r~255,g~255,b~255; background (black) has r,g,b all near 0
          if (rgba.r > 50 || rgba.g > 50 || rgba.b > 50) return true;
        }
      }
      return false;
    })();
    expect(found).toBeTruthy();

    controller.imageUploader = undefined;
    controller.sendGetFn = undefined;
  });

  test('generateAndUploadImage defaults to center alignment when payload is string', async () => {
    const devmod = await import('../deviceController');
    const controller = new devmod.default([device], { afterCommand: false });
    const uploadMock = jest.fn().mockResolvedValue(true);
    controller.imageUploader = uploadMock;
    const spy = jest.spyOn(devmod, 'buildSvgForText');
    controller.sendGetFn = jest.fn().mockResolvedValue({ status: 200 } as any);
    await controller.generateAndUploadImage(device.name, 'Simple string');
    expect(spy).toHaveBeenCalled();
    const args = spy.mock.calls[spy.mock.calls.length - 1];
    expect(args[4]).toEqual({ halign: 'center', valign: 'center' });
    spy.mockRestore();
    controller.imageUploader = undefined;
    controller.sendGetFn = undefined;
  });
});
