import { Device } from './types';
import type { MqttPublishFn, ImageGeneratePayload } from './types';
import * as httpClient from './httpClient';
import Jimp from 'jimp';
import sharp from 'sharp';
import { log, warn } from './logger';

// Build a 240x240 SVG from the markup text. This is exported so tests can assert layout
export function buildSvgForText(
  text: string,
  bg: string,
  defaultTextColor: string,
  fontSize: number,
  options?: { halign?: 'left' | 'center' | 'right'; valign?: 'top' | 'center' | 'bottom'; hmargin?: number; vmargin?: number; transparentBg?: boolean }
) {
  // parse blocks and markup (images, color, bold, italic). This mirrors the code used by
  // generateAndUploadImage but is separated out for testability and clearer newline handling.
  const imgTagRe = /\[img:([^\]]+)\]/gi;
  const blocks: Array<{ type: 'text' | 'image'; text?: string; src?: string; width?: number; height?: number }> = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = imgTagRe.exec(text)) !== null) {
    const idx = m.index;
    if (idx > cursor) blocks.push({ type: 'text', text: text.slice(cursor, idx) });
    // Parse optional size spec for inline images: `datauri|WxH` or `datauri|W` (square)
    let srcRaw = m[1];
    let imgW: number | undefined = undefined;
    let imgH: number | undefined = undefined;
    const pipeIdx = srcRaw.indexOf('|');
    if (pipeIdx !== -1) {
      const sizePart = srcRaw.slice(pipeIdx + 1);
      srcRaw = srcRaw.slice(0, pipeIdx);
      const dims = sizePart.split('x');
      const tw = Number(dims[0]);
      if (!Number.isNaN(tw) && Number.isFinite(tw) && tw > 0) imgW = Math.trunc(tw);
      if (dims.length > 1) {
        const th = Number(dims[1]);
        if (!Number.isNaN(th) && Number.isFinite(th) && th > 0) imgH = Math.trunc(th);
      }
      if (imgW && !imgH) imgH = imgW;
      // clamp to image bounds
      if (imgW) imgW = Math.max(1, Math.min(240, imgW));
      if (imgH) imgH = Math.max(1, Math.min(240, imgH));
    }
    blocks.push({ type: 'image', src: srcRaw, width: imgW, height: imgH });
    cursor = idx + m[0].length;
  }
  if (cursor < text.length) blocks.push({ type: 'text', text: text.slice(cursor) });

  // starting font size (may be reduced to fit vertically)
  let currentFontSize = Math.trunc(fontSize) || 28;

    // Parse [b]...[/b] and [i]...[/i] inside a (possibly colored) run
    const parseBoldItalic = (s: string, color: string) => {
      const out: Array<{ text: string; color?: string; bold?: boolean; italic?: boolean }> = [];
      const bRe = /\[b\]([\s\S]*?)\[\/b\]/gi;
      let pos = 0;
      let mm: RegExpExecArray | null;
      while ((mm = bRe.exec(s)) !== null) {
        const i = mm.index;
        if (i > pos) out.push(...parseItalicSpans(s.slice(pos, i), color, false));
        out.push(...parseItalicSpans(mm[1], color, true));
        pos = i + mm[0].length;
      }
      if (pos < s.length) out.push(...parseItalicSpans(s.slice(pos), color, false));
      return out;
    };

    const parseItalicSpans = (s: string, color: string, bold: boolean) => {
      const final: Array<{ text: string; color?: string; bold?: boolean; italic?: boolean }> = [];
      const iRe = /\[i\]([\s\S]*?)\[\/i\]/gi;
      let p = 0;
      let mm2: RegExpExecArray | null;
      while ((mm2 = iRe.exec(s)) !== null) {
        const ii = mm2.index;
        if (ii > p) final.push({ text: s.slice(p, ii), color, bold });
        final.push({ text: mm2[1], color, bold, italic: true });
        p = ii + mm2[0].length;
      }
      if (p < s.length) final.push({ text: s.slice(p), color, bold });
      return final;
    };

    // Parse [color=#rrggbb]...[/color] blocks and delegate bold/italic parsing
    const parseStyledSpans = (s: string, baseColor: string) => {
      const spans: Array<{ text: string; color?: string; bold?: boolean; italic?: boolean }> = [];
      const colorRe = /\[color=([^\]]+)\]([\s\S]*?)\[\/color\]/gi;
      let pos = 0;
      let mm: RegExpExecArray | null;
      while ((mm = colorRe.exec(s)) !== null) {
        const i = mm.index;
        if (i > pos) spans.push(...parseBoldItalic(s.slice(pos, i), baseColor));
        spans.push(...parseBoldItalic(mm[2], mm[1]));
        pos = i + mm[0].length;
      }
      if (pos < s.length) spans.push(...parseBoldItalic(s.slice(pos), baseColor));
      return spans;
    };

    // Layout builder: tokenizes inline images and wraps into lines
    const SVG_WIDTH = 240;
    const SVG_HEIGHT = 240;
    const buildLayout = (fSize: number) => {
      const lines: Array<{ type: 'text'; spans: any[] } | { type: 'image'; src: string; width?: number; height?: number } > = [];
      const maxTextWidth = SVG_WIDTH - 8; // margin 4px each side
      const charWidth = fSize * 0.6;

      // Tokenize blocks into inline tokens and wrap into token lines
      const tokenLines: Array<any[]> = [];
      let curLineTokens: any[] = [];
      let curLineWidth = 0;

      for (const blk of blocks) {
        if (blk.type === 'image') {
          const inlineDefault = Math.max(1, Math.trunc(fSize));
          const imgW = typeof blk.width === 'number' ? blk.width : inlineDefault;
          const imgH = typeof blk.height === 'number' ? blk.height : imgW;
          if (curLineWidth + imgW > maxTextWidth && curLineTokens.length > 0) {
            tokenLines.push(curLineTokens);
            curLineTokens = [];
            curLineWidth = 0;
          }
          curLineTokens.push({ type: 'image', src: blk.src, width: imgW, height: imgH, explicitSize: !!blk.width || !!blk.height });
          curLineWidth += imgW;
          continue;
        }

        const spansLocal = parseStyledSpans(blk.text || '', defaultTextColor);
        for (const sp of spansLocal) {
          const segments = sp.text.split('\n');
          for (let si = 0; si < segments.length; si++) {
            const seg = segments[si];
            const words = seg.split(/(\s+)/);
            for (const w of words) {
              const wLen = w.length * charWidth;
              if (curLineWidth + wLen > maxTextWidth && curLineTokens.length > 0) {
                tokenLines.push(curLineTokens);
                curLineTokens = [];
                curLineWidth = 0;
              }
              if (w.length > 0) {
                curLineTokens.push({ type: 'text', text: w, color: sp.color, bold: sp.bold, italic: sp.italic, width: wLen });
                curLineWidth += wLen;
              }
            }
            if (si < segments.length - 1) {
              tokenLines.push(curLineTokens);
              curLineTokens = [];
              curLineWidth = 0;
            }
          }
        }
      }
      if (curLineTokens.length > 0) tokenLines.push(curLineTokens);

      // Convert token lines into final 'lines' array, preserving inline image tokens inside text lines
      for (const tline of tokenLines) {
        if (tline.length === 1 && tline[0].type === 'image') {
          const img = tline[0];
          lines.push({ type: 'image', src: img.src, width: img.width, height: img.height });
        } else {
          const spansOut: any[] = [];
          for (const tok of tline) {
            if (tok.type === 'text') spansOut.push({ text: tok.text, color: tok.color, bold: tok.bold, italic: tok.italic, width: tok.width });
            else if (tok.type === 'image') spansOut.push({ img: true, src: tok.src, width: tok.width, height: tok.height, explicitSize: tok.explicitSize });
          }
          lines.push({ type: 'text', spans: spansOut });
        }
      }

      const lineHeight = Math.round(fSize * 1.2);
      // baseline offset from the top of the line to the text baseline
      const baselineOffset = lineHeight - (lineHeight / 4);
      let totalH = 0;
      for (const l of lines) {
        if (l.type === 'text') totalH += lineHeight;
        else {
          const ih = (l as any).height || 96;
          totalH += Math.min(ih, SVG_HEIGHT / 3);
        }
      }
      return { lines, totalH, lineHeight };
    };

  // Reduce font size if layout height exceeds image height
  let layout = buildLayout(currentFontSize);
  while (layout.totalH > SVG_HEIGHT - 8 && currentFontSize > 10) {
    currentFontSize -= 2;
    layout = buildLayout(currentFontSize);
  }

  // Build SVG string
  const { lines, lineHeight } = layout;
  const baselineOffset = lineHeight - (lineHeight / 4);
  // alignment defaults and margins
  const halign = (options && options.halign) || 'center';
  const valign = (options && options.valign) || 'center';
  // margins: integer pixels; if undefined we preserve existing default behavior
  const hmarginOpt = options && typeof options.hmargin === 'number' ? Math.trunc(options.hmargin) : undefined;
  const vmarginOpt = options && typeof options.vmargin === 'number' ? Math.trunc(options.vmargin) : undefined;
  // Compute starting Y based on vertical alignment
  const minTop = 12;
  let y: number;
  if (valign === 'top') {
    const vm = typeof vmarginOpt === 'number' ? vmarginOpt : minTop;
    y = vm + baselineOffset;
  } else if (valign === 'bottom') {
    const vm = typeof vmarginOpt === 'number' ? vmarginOpt : 0;
    y = Math.round(SVG_HEIGHT - vm - layout.totalH) + baselineOffset;
  } else {
    const centerBase = Math.round((SVG_HEIGHT - layout.totalH) / 2) + baselineOffset;
    const vm = typeof vmarginOpt === 'number' ? vmarginOpt : 0;
    y = Math.max(minTop, centerBase + vm);
  }
  const svgParts: string[] = [];
  svgParts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${SVG_HEIGHT}">`);
  // Optionally render background rectangle; when composing multiple layers we often want only
  // the bottom-most layer to paint a background and subsequent layers to be transparent.
  if (!options || !options.transparentBg) svgParts.push(`<rect width="100%" height="100%" fill="${bg}"/>`);
  let idx = 0;
  for (const l of lines) {
    if (l.type === 'image') {
      const defaultMargin = 4;
      const imgMargin = typeof hmarginOpt === 'number' ? hmarginOpt : defaultMargin;
      const imgW = (l as any).width || 96;
      const imgH = (l as any).height || 96;
      let x: number;
      if (halign === 'left') x = imgMargin;
      else if (halign === 'right') x = Math.round(SVG_WIDTH - imgW - imgMargin);
      else x = Math.round((SVG_WIDTH - imgW) / 2 + (typeof hmarginOpt === 'number' ? hmarginOpt : 0));
      const yImg = Math.round(y - imgH / 2);
      const src = (l as any).src;
      svgParts.push(`<image x="${x}" y="${yImg}" width="${imgW}" height="${imgH}" href="${src}" />`);
      y += imgH + 6;
    } else {
      const tokens = l.spans as any[];
      const hasImage = tokens.some((t) => t.img);
      if (!hasImage) {
        // Simple single-text line: preserve previous behavior (single <text> with anchor)
        let tspanParts = '';
        for (const sp of tokens) {
          const fill = sp.color || defaultTextColor;
          const fontWeight = sp.bold ? '700' : '400';
          const fontStyle = sp.italic ? 'italic' : 'normal';
          const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          tspanParts += `<tspan fill="${fill}" font-weight="${fontWeight}" font-style="${fontStyle}">${esc(sp.text)}</tspan>`;
        }
        // choose x & anchor based on horizontal alignment
        const defaultMargin = 4;
        const margin = typeof hmarginOpt === 'number' ? hmarginOpt : defaultMargin;
        let xVal: number | string = SVG_WIDTH / 2;
        let anchor = 'middle';
        if (halign === 'left') {
          xVal = margin;
          anchor = 'start';
        } else if (halign === 'right') {
          xVal = SVG_WIDTH - margin;
          anchor = 'end';
        } else if (halign === 'center' && typeof hmarginOpt === 'number') {
          xVal = Math.round(SVG_WIDTH / 2 + hmarginOpt);
        }
        svgParts.push(`<text xml:space="preserve" x="${xVal}" y="${y}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${currentFontSize}" text-anchor="${anchor}">${tspanParts}</text>`);
        y += lineHeight;
      } else {
        // Line contains inline images: compute absolute positions for each token
        const totalWidth = tokens.reduce((acc, t) => acc + (t.width || 0), 0);
        const defaultMargin = 4;
        const margin = typeof hmarginOpt === 'number' ? hmarginOpt : defaultMargin;
        let startX: number;
        if (halign === 'left') startX = margin;
        else if (halign === 'right') startX = Math.round(SVG_WIDTH - margin - totalWidth);
        else startX = Math.round((SVG_WIDTH - totalWidth) / 2 + (typeof hmarginOpt === 'number' ? hmarginOpt : 0));

        let cx = startX;
        for (let ti = 0; ti < tokens.length; ) {
          const tok = tokens[ti];
          if (tok.img) {
            const imgW = tok.width || 16;
            const imgH = tok.height || imgW;
            // Align inline images to the text baseline for better visual fit.
            // Approximate descent as ~20% of font size and place image bottom at baseline-descent.
            const descent = Math.round(currentFontSize * 0.2);
            const yImg = Math.round(y - imgH + descent);
            const src = tok.src;
            svgParts.push(`<image x="${cx}" y="${yImg}" width="${imgW}" height="${imgH}" href="${src}" />`);
            cx += imgW;
            ti++;
          } else {
            // gather consecutive text tokens
            let groupWidth = 0;
            let tspanParts = '';
            const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            while (ti < tokens.length && !tokens[ti].img) {
              const sp = tokens[ti];
              const fill = sp.color || defaultTextColor;
              const fontWeight = sp.bold ? '700' : '400';
              const fontStyle = sp.italic ? 'italic' : 'normal';
              tspanParts += `<tspan fill="${fill}" font-weight="${fontWeight}" font-style="${fontStyle}">${esc(sp.text)}</tspan>`;
              groupWidth += sp.width || 0;
              ti++;
            }
            svgParts.push(`<text xml:space="preserve" x="${cx}" y="${y}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${currentFontSize}" text-anchor="start">${tspanParts}</text>`);
            cx += groupWidth;
          }
        }
        y += lineHeight;
      }
    }
    idx++;
  }
  svgParts.push('</svg>');
  const svg = svgParts.join('\n');
  return { svg, usedFontSize: currentFontSize };
}

// Helper to apply rotate/flip transforms to a Sharp pipeline.
function applyTransformsToSharp(sh: any, rotateDeg?: number, flipV?: boolean, flipH?: boolean) {
  if (!sh) return sh;
  const allowed = [0, 90, 180, 270];
  if (typeof rotateDeg === 'number' && allowed.includes(rotateDeg) && rotateDeg !== 0) {
    sh = sh.rotate(rotateDeg);
  }
  if (flipV) sh = sh.flip();
  if (flipH) sh = sh.flop();
  return sh;
}

export class DeviceController {
  devicesByName: Map<string, Device>;
  verifyOptions: any;
  deviceStates: Map<string, { brt?: number; theme?: number; colon?: number; hour12?: number; dst?: number }> = new Map();
  devicePollTimers: Map<string, NodeJS.Timeout> = new Map();
  mqttPublisher?: MqttPublishFn;
  imageStatusPublisher?: import('./types').MqttImageStatusFn;
  // Optional override hook used by tests to intercept image uploads.
  // signature: device, buffer, filename, contentType
  imageUploader?: (device: Device, buf: Buffer, filename: string, contentType: string) => Promise<boolean>;
  // Optional override for HTTP GET requests (used in tests for image flow)
  sendGetFn?: (url: string) => Promise<any>;
  // Optional publisher for per-device status messages (e.g., `gm/<device>/STATUS`)
  statusPublisher?: (deviceName: string, payload: string, retain?: boolean) => Promise<void>;
  // Cache the last published status per-device to avoid duplicate publishes
  deviceStatuses: Map<string, 'ONLINE'|'OFFLINE'> = new Map();

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

  setImageStatusPublisher(p: import('./types').MqttImageStatusFn) {
    this.imageStatusPublisher = p;
  }

  setStatusPublisher(p: (deviceName: string, payload: string, retain?: boolean) => Promise<void>) {
    this.statusPublisher = p;
  }

  private async publishImageStatus(deviceName: string, payload: any, retain = true): Promise<void> {
    if (!this.imageStatusPublisher) return;
    try {
      const pl = typeof payload === 'string' ? payload : JSON.stringify(payload);
      await this.imageStatusPublisher(deviceName, pl, retain);
    } catch (err: any) {
      warn('Failed to publish IMAGE/STATUS', deviceName, err?.message || err);
    }
  }

  // Publish a device-level status (ONLINE/OFFLINE). Only publish when the value changed or when forced.
  private async maybePublishDeviceStatus(deviceName: string, payload: 'ONLINE'|'OFFLINE', forcePublish = false) {
    if (!this.statusPublisher) return;
    const prev = this.deviceStatuses.get(deviceName);
    if (!forcePublish && prev === payload) return;
    try {
      await this.statusPublisher(deviceName, payload, true);
      this.deviceStatuses.set(deviceName, payload);
    } catch (err: any) {
      warn('Failed to publish device status', deviceName, err?.message || err);
    }
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
        if (data === null) {
          // fetching JSON failed - mark device offline and retry; continue attempts
          warn('Verification fetch returned null (possible HTTP error)', command, 'for', device.name);
          await this.maybePublishDeviceStatus(device.name, 'OFFLINE');
        }
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
        // mark device offline when verification fetch errors occur
        try { await this.maybePublishDeviceStatus(device.name, 'OFFLINE', true); } catch (_) { /* ignore */ }
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

  // Determine requested image transforms from device configuration
  const flipV = device.image && device.image.flip && device.image.flip.vertical === true;
  const flipH = device.image && device.image.flip && device.image.flip.horizontal === true;
  const rotateDeg = Number(device.image && typeof (device.image as any).rotate === 'number' ? (device.image as any).rotate : 0);
  log('IMAGE/SET transforms', device.name, { rotateDeg, flipV, flipH });

  if (format === 'gif') {
        const w = meta.width || 0;
        const h = meta.height || 0;
        if (w === finalSize && h === finalSize && !flipV && !flipH && (!rotateDeg || rotateDeg === 0)) {
          // already the right size and no transforms requested — upload GIF as-is
          finalBuffer = buffer;
          finalExt = 'gif';
          finalMime = 'image/gif';
        } else if (w === finalSize && h === finalSize) {
          // already 240x240 but transforms requested — apply them, preserve animation if present
          let s = sharp(buffer, { animated: true });
          s = applyTransformsToSharp(s, rotateDeg, flipV, flipH);
          finalBuffer = await s.gif().toBuffer();
          finalExt = 'gif';
          finalMime = 'image/gif';
        } else {
          // Resize/crop while preserving animation using sharp's animated pipeline
          const fit = oversize === 'crop' ? 'cover' : 'contain';
          const position = mapPosition(cropposition) as any;
          let s = sharp(buffer, { animated: true }).resize(finalSize, finalSize, { fit: fit as any, position, background: { r: 255, g: 255, b: 255, alpha: 1 } });
          s = applyTransformsToSharp(s, rotateDeg, flipV, flipH);
          finalBuffer = await s.gif().toBuffer();
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
          let s = sharp(buffer).extract({ left, top, width: finalSize, height: finalSize });
          s = applyTransformsToSharp(s, rotateDeg, flipV, flipH);
          finalBuffer = await s.jpeg({ quality: 90 }).toBuffer();
        } else {
          const position = mapPosition(cropposition) as any;
          let s = sharp(buffer).resize(finalSize, finalSize, { fit: 'contain', position, background: { r: 255, g: 255, b: 255, alpha: 1 } });
          s = applyTransformsToSharp(s, rotateDeg, flipV, flipH);
          finalBuffer = await s.jpeg({ quality: 90 }).toBuffer();
        }
        finalExt = 'jpg';
        finalMime = 'image/jpeg';
      }

      const uploadUrl = `http://${device.host}/doUpload?dir=/image/`;
      const filename = `upload.${finalExt}`;
      await this.publishImageStatus(device.name, { stage: 'uploading', filename });
      const uploadOk = this.imageUploader ? await this.imageUploader(device, finalBuffer, filename, finalMime) : await httpClient.postForm(uploadUrl, 'image', finalBuffer, filename, finalMime);
      if (!uploadOk) {
        await this.publishImageStatus(device.name, { stage: 'upload_failed', filename });
        return false;
      }
      await this.publishImageStatus(device.name, { stage: 'uploaded', filename });

      // After upload, try to select the image and set theme using a robust helper
  await this.publishImageStatus(device.name, { stage: 'selecting', filename });
  const sel = await this.selectImageAndSetTheme(device, filename);
  // Log the successful URLs (if any) to aid debugging
  log('IMAGE/SET final status', device.name, 'themeOk', sel.themeOk, 'imgSelected', sel.imgSelected, 'themeUrl', sel.themeUrl ?? 'none', 'imgUrl', sel.imgUrl ?? 'none');
  await this.publishImageStatus(device.name, { stage: 'done', themeOk: sel.themeOk, imgSelected: sel.imgSelected, themeUrl: sel.themeUrl, imgUrl: sel.imgUrl });

      // If verification is enabled, rely on verification to publish state; otherwise publish only when we have evidence of success
      if (this.verifyOptions?.afterCommand) {
        await this.verifyCommand(device, 'THEME', 3);
      } else {
        if (sel.themeOk) this.maybePublishState(device.name, { theme: 3 });
      }
      // Set per-device status depending on whether the device accepted our change
      if (sel.themeOk || sel.imgSelected) {
        await this.maybePublishDeviceStatus(device.name, 'ONLINE');
      } else {
        await this.maybePublishDeviceStatus(device.name, 'OFFLINE');
      }
      return sel.themeOk || sel.imgSelected;
    } catch (err: any) {
      warn('Image processing/upload failed', err?.message || err);
      await this.publishImageStatus(device.name, { stage: 'error', message: err?.message || err });
      // On errors, mark the device as offline
      await this.maybePublishDeviceStatus(device.name, 'OFFLINE');
      return false;
    }
  }

  // Try multiple variants of the uploaded image path (encoded/unencoded, single/double slash, leading slash/no slash)
  // and try both orders (theme first / image first) with retries. Returns which operations reported success.
  private async selectImageAndSetTheme(device: Device, filename: string, options?: { selectionDelayMs?: number; attempts?: number; initialDelayMs?: number; }): Promise<{ themeOk: boolean; imgSelected: boolean; themeUrl?: string; imgUrl?: string }> {
    const sendGetToUse = this.sendGetFn ?? httpClient.sendGet;
        const selectionDelayMs = options?.selectionDelayMs ?? (device.image && typeof device.image.selectionDelayMs === 'number' ? device.image.selectionDelayMs : 250);
        const attempts = options?.attempts ?? (device.image && typeof device.image.selectionAttempts === 'number' ? device.image.selectionAttempts : 2);
        const initialDelayMs = options?.initialDelayMs ?? (device.image && typeof device.image.selectionInitialDelayMs === 'number' ? device.image.selectionInitialDelayMs : 200);

    const wait = (ms: number) => new Promise((res) => {
      const t = setTimeout(res, ms);
      if (typeof (t as any).unref === 'function') (t as any).unref();
    });

        const tryOnce = async (url: string, description: string): Promise<boolean> => {
          try {
            log('IMAGE/GENERATE', description, 'trying', device.name, url);
            const res = await sendGetToUse(url);
            const ok = res && (res as any).status && (res as any).status >= 200 && (res as any).status < 300;
            if (ok) {
              log('IMAGE/GENERATE', description, 'OK', device.name, `status:${(res as any).status}`);
              return true;
              // Device successfully verified - mark as ONLINE
              await this.maybePublishDeviceStatus(device.name, 'ONLINE');
            }
            const status = res && (res as any).status ? (res as any).status : undefined;
            let snippet = '';
            try {
              if (res && (res as any).data) {
                const s = typeof (res as any).data === 'string' ? (res as any).data : JSON.stringify((res as any).data);
                snippet = s.slice(0, 200);
              }
            } catch (e) {
              snippet = String((res as any).data || '');
            }
            log('IMAGE/GENERATE', description, 'non-2xx or null', device.name, `status:${status}`, `body:${snippet}`);
          } catch (err: any) {
            warn('IMAGE/GENERATE', description, 'error', device.name, err?.message || err);
          }
          return false;
        };

    // Give the device a bit more time to process the uploaded file
    await wait(selectionDelayMs);

    // Candidate raw paths
    const base = `/image`;
    const rawCandidates = [`${base}//${filename}`, `${base}/${filename}`, `/${filename}`, `${filename}`];

    // Helper to generate both encoded and raw URL forms for a given path
    const urlVariants = (p: string) => {
      return [
        `http://${device.host}/set?img=${encodeURIComponent(p)}`,
        `http://${device.host}/set?img=${p}`,
      ];
    };

    // First try: select image first then set theme (batch passes)
    const themeUrl = `http://${device.host}/set?theme=3`;
  let themeOk = false;
  let imgSelected = false;
  let successfulThemeUrl: string | undefined;
  let successfulImgUrl: string | undefined;
    let delayBatch = initialDelayMs;

    // Try selecting image with up to `attempts` passes
    for (let pass = 1; pass <= attempts; pass++) {
      log('IMAGE/GENERATE', 'set image pass', pass, device.name);
      for (const p of rawCandidates) {
        for (const url of urlVariants(p)) {
          if (await tryOnce(url, 'set image')) {
            imgSelected = true;
            successfulImgUrl = url;
            break;
          }
        }
        if (imgSelected) break;
      }
      if (imgSelected) break;
      if (pass < attempts) await wait(delayBatch);
      delayBatch *= 2;
    }

    if (imgSelected) {
      // try setting theme after image selection
      delayBatch = initialDelayMs;
      for (let pass = 1; pass <= attempts; pass++) {
        log('IMAGE/GENERATE', 'set theme pass', pass, device.name, themeUrl);
        if (await tryOnce(themeUrl, 'set theme')) {
          themeOk = true;
          successfulThemeUrl = themeUrl;
          break;
        }
        if (pass < attempts) await wait(delayBatch);
        delayBatch *= 2;
      }
      return { themeOk, imgSelected, themeUrl: successfulThemeUrl, imgUrl: successfulImgUrl };
    }

    // Second try (fallback): set theme then select image
    delayBatch = initialDelayMs;
    // Try theme first with up to `attempts` passes
    for (let pass = 1; pass <= attempts; pass++) {
      log('IMAGE/GENERATE', 'set theme pass', pass, device.name, themeUrl);
      if (await tryOnce(themeUrl, 'set theme')) {
        themeOk = true;
        successfulThemeUrl = themeUrl;
        break;
      }
      if (pass < attempts) await wait(delayBatch);
      delayBatch *= 2;
    }

    if (themeOk) {
      // try selecting image with up to `attempts` passes
      delayBatch = initialDelayMs;
      for (let pass = 1; pass <= attempts; pass++) {
        log('IMAGE/GENERATE', 'set image pass', pass, device.name);
        for (const p of rawCandidates) {
          for (const url of urlVariants(p)) {
            if (await tryOnce(url, 'set image')) {
              imgSelected = true;
              successfulImgUrl = url;
              break;
            }
          }
          if (imgSelected) break;
        }
  if (imgSelected) return { themeOk, imgSelected, themeUrl: successfulThemeUrl, imgUrl: successfulImgUrl };
        if (pass < attempts) await wait(delayBatch);
        delayBatch *= 2;
      }
  return { themeOk, imgSelected, themeUrl: successfulThemeUrl, imgUrl: successfulImgUrl };
    }

    // Nothing worked
    return { themeOk: false, imgSelected: false };
  }

  // Generate an image from text/markup and upload it to the device, then select it
  async generateAndUploadImage(deviceName: string, payload: ImageGeneratePayload): Promise<boolean> {
    const device = this.getDevice(deviceName);
    if (!device) {
      warn('Device not found', deviceName);
      return false;
    }

    // normalize payload. Accept either a single item or an array of items
    const items: Array<any> = Array.isArray(payload) ? payload : [payload];
    // Convert simple string payloads to default object form
    for (let i = 0; i < items.length; i++) {
      if (typeof items[i] !== 'object') items[i] = { text: String(items[i] || '') };
    }

    // parse each item into normalized fields
    const normalized = items.map((it: any) => {
      const obj = it || {};
      const text = String(obj.text || obj.message || obj.value || '');
      const bg = obj.background ? String(obj.background) : '#000000';
      const defaultTextColor = obj.textColor ? String(obj.textColor) : '#ffffff';
      const fontSize = obj.fontSize ? Number(obj.fontSize) || 28 : 28;
      let halign: 'left' | 'center' | 'right' = 'center';
      let valign: 'top' | 'center' | 'bottom' = 'center';
      if (obj.halign) {
        const hv = String(obj.halign).toLowerCase();
        if (hv === 'left' || hv === 'center' || hv === 'right') halign = hv as any;
      }
      if (obj.valign) {
        const vv = String(obj.valign).toLowerCase();
        if (vv === 'top' || vv === 'center' || vv === 'bottom') valign = vv as any;
      }
      let hmargin: number | undefined = undefined;
      let vmargin: number | undefined = undefined;
      if (obj.hmargin !== undefined && obj.hmargin !== null) {
        const hm = Number(obj.hmargin);
        if (!Number.isNaN(hm)) hmargin = Math.trunc(hm);
      }
      if (obj.vmargin !== undefined && obj.vmargin !== null) {
        const vm = Number(obj.vmargin);
        if (!Number.isNaN(vm)) vmargin = Math.trunc(vm);
      }
      return { text, bg, defaultTextColor, fontSize, halign, valign, hmargin, vmargin };
    });

    if (!normalized || normalized.length === 0) {
      warn('IMAGE/GENERATE missing text payload for', deviceName);
      return false;
    }

  // Use shared helper to build SVG string (handles newline and space preservation)

    const devmod = await import('./deviceController');

    // For arrays, render each layer separately and composite in-order (first = bottommost)
    const svgItems: Array<{ svg: string; usedFontSize: number }> = [];
    let totalTextLen = 0;
    for (let i = 0; i < normalized.length; i++) {
      const itm = normalized[i];
      totalTextLen += itm.text.length;
      const transparentBg = i > 0; // only bottom-most layer should draw a background
      const res = (devmod as any).buildSvgForText(itm.text, itm.bg, itm.defaultTextColor, itm.fontSize, { halign: itm.halign, valign: itm.valign, hmargin: itm.hmargin, vmargin: itm.vmargin, transparentBg });
      svgItems.push(res);
    }
    const currentFontSize = svgItems[0]?.usedFontSize ?? 28;

    try {
    // logging: total text length and number of layers
    log('IMAGE/GENERATE rendering', device.name, 'layers', svgItems.length, 'totalTextLen', totalTextLen);
    await this.publishImageStatus(device.name, { stage: 'rendering', layers: svgItems.length, textLen: totalTextLen });
      // render SVG layers to PNG buffers and composite
    const flipV = device.image && device.image.flip && device.image.flip.vertical === true;
    const flipH = device.image && device.image.flip && device.image.flip.horizontal === true;
  const rotateDeg = Number((device.image && typeof (device.image as any).rotate === 'number') ? (device.image as any).rotate : 0);
  log('IMAGE/GENERATE transforms', device.name, { rotateDeg, flipV, flipH });
      // Render each svg into PNG buffers with alpha so they can be composed.
      const pngBuffers: Buffer[] = [];
      for (let i = 0; i < svgItems.length; i++) {
        const sv = svgItems[i].svg;
        const png = await sharp(Buffer.from(sv)).resize(240, 240).png().toBuffer();
        pngBuffers.push(png);
      }
      // Composite layers: first item is base, subsequent are overlaid in order
      let composedPng = pngBuffers[0];
      if (pngBuffers.length > 1) {
        for (let i = 1; i < pngBuffers.length; i++) {
          composedPng = await sharp(composedPng).composite([{ input: pngBuffers[i], blend: 'over' }]).png().toBuffer();
        }
      }
      // Convert to JPEG: flatten any transparency to the first layer background (or black)
      const baseBg = normalized[0].bg || '#000000';
      let s = sharp(composedPng).flatten({ background: baseBg }).resize(240, 240);
      s = applyTransformsToSharp(s, rotateDeg, flipV, flipH);
      const outBuf = await s.jpeg({ quality: 90 }).toBuffer();
      log('IMAGE/GENERATE rendered', device.name, 'bytes', outBuf.length);
      // upload like processImageAndUpload: use jpg
      const uploadUrl = `http://${device.host}/doUpload?dir=/image/`;
      const filename = `upload.jpg`;
      log('IMAGE/GENERATE uploading', device.name, uploadUrl, 'filename', filename, 'contentType', 'image/jpeg', 'size', outBuf.length);
      const uploadOk = this.imageUploader ? await this.imageUploader(device, outBuf, filename, 'image/jpeg') : await httpClient.postForm(uploadUrl, 'image', outBuf, filename, 'image/jpeg');
      if (!uploadOk) {
        warn('IMAGE/GENERATE upload failed', device.name);
        return false;
      }
  log('IMAGE/GENERATE upload OK', device.name, 'filename', filename);
  await this.publishImageStatus(device.name, { stage: 'uploaded', filename });

      const sendGetToUse = this.sendGetFn ?? httpClient.sendGet;

      // little helper to try an URL with retries
      const trySetUrl = async (url: string, description: string, attempts = 2, initialDelayMs = 200): Promise<boolean> => {
        let delay = initialDelayMs;
        for (let attempt = 1; attempt <= attempts; attempt++) {
          try {
            log('IMAGE/GENERATE', description, 'attempt', attempt, device.name, url);
            const res = await sendGetToUse(url);
            const ok = res && (res as any).status && (res as any).status >= 200 && (res as any).status < 300;
            if (ok) {
              log('IMAGE/GENERATE', description, 'OK', device.name, `status:${(res as any).status}`);
              return true;
            }
            // Log more context: status and a short snippet of the response body if present
            const status = res && (res as any).status ? (res as any).status : undefined;
            let snippet = '';
            try {
              if (res && (res as any).data) {
                const s = typeof (res as any).data === 'string' ? (res as any).data : JSON.stringify((res as any).data);
                snippet = s.slice(0, 200);
              }
            } catch (e) {
              snippet = String((res as any).data || '');
            }
            log('IMAGE/GENERATE', description, 'non-2xx or null', device.name, `status:${status}`, `body:${snippet}`);
          } catch (err: any) {
            warn('IMAGE/GENERATE', description, 'error', device.name, err?.message || err);
          }
          await new Promise((resolve) => {
            const t = setTimeout(resolve, delay);
            if (typeof (t as any).unref === 'function') (t as any).unref();
          });
          delay *= 2;
        }
        return false;
      };

  // Use the shared helper to try selecting the image and setting the theme robustly
  await this.publishImageStatus(device.name, { stage: 'selecting', filename });
  const sel = await this.selectImageAndSetTheme(device, filename);
  log('IMAGE/GENERATE final status', device.name, 'themeOk', sel.themeOk, 'imgSelected', sel.imgSelected, 'themeUrl', sel.themeUrl ?? 'none', 'imgUrl', sel.imgUrl ?? 'none');
  await this.publishImageStatus(device.name, { stage: 'done', themeOk: sel.themeOk, imgSelected: sel.imgSelected, themeUrl: sel.themeUrl, imgUrl: sel.imgUrl });

      let themeOk = sel.themeOk;

      // If our attempts didn't report success, do a one-shot verification fetch of app.json to see
      // whether the device already has THEME=3 (some firmwares apply changes despite returning non-2xx)
      if (!themeOk) {
        try {
          // Prefer a quick GET hook when tests provide `sendGetFn` so we don't block on axios timeouts
          let data: any = null;
          if (this.sendGetFn) {
            try {
              const res = await (this.sendGetFn as any)(`http://${device.host}/app.json`);
              if (res && (res as any).data) data = (res as any).data;
            } catch (e) {
              // ignore - don't fall back to httpClient when a test hook exists
            }
          } else {
            data = await httpClient.getJson(`http://${device.host}/app.json`);
          }
          let currentTheme: number | undefined;
          if (data && typeof data === 'object') {
            if (typeof (data as any).theme === 'number') currentTheme = Number((data as any).theme);
            else if (typeof (data as any).value === 'number') currentTheme = Number((data as any).value);
            else if ((data as any).app && typeof (data as any).app === 'object') {
              if (typeof (data as any).app.theme === 'number') currentTheme = Number((data as any).app.theme);
              else if (typeof (data as any).app.value === 'number') currentTheme = Number((data as any).app.value);
            }
          }
          if (currentTheme === 3) {
            log('IMAGE/GENERATE verification matched THEME', device.name, currentTheme);
            themeOk = true;
            // publish state when verification deterministically matched
            if (!this.verifyOptions?.afterCommand) this.maybePublishState(device.name, { theme: 3 }, true);
          } else {
            log('IMAGE/GENERATE verification THEME value', device.name, currentTheme);
          }
        } catch (err: any) {
          warn('IMAGE/GENERATE verification fetch error', device.name, err?.message || err);
        }
      }

      if (this.verifyOptions?.afterCommand) {
        await this.verifyCommand(device, 'THEME', 3);
      } else {
        if (themeOk) {
          this.maybePublishState(device.name, { theme: 3 }, true);
        } else {
          warn('IMAGE/GENERATE set theme did not return success and verification failed', device.name);
          await this.publishImageStatus(device.name, { stage: 'error', message: 'set theme did not return success and verification failed' });
        }
      }
      // Set per-device status depending on whether the device accepted our change
      if (themeOk || sel.imgSelected) {
        await this.maybePublishDeviceStatus(device.name, 'ONLINE');
      } else {
        await this.maybePublishDeviceStatus(device.name, 'OFFLINE');
      }
      return themeOk || sel.imgSelected;
    } catch (err: any) {
      warn('IMAGE/GENERATE processing failed', err?.message || err);
      await this.publishImageStatus(device.name, { stage: 'error', message: err?.message || err });
      // On processing error, mark the device offline
      await this.maybePublishDeviceStatus(device.name, 'OFFLINE');
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
      // If the device didn't return certain keys, publish sensible defaults so MQTT topics exist
      const prev = this.deviceStates.get(device.name);
      const defaults: any = {};
      // For boolean flags, default to NO (0) when previously unknown
      if (partial.colon === undefined && (!prev || prev.colon === undefined)) defaults.colon = 0;
      if (partial.hour12 === undefined && (!prev || prev.hour12 === undefined)) defaults.hour12 = 0;
      if (partial.dst === undefined && (!prev || prev.dst === undefined)) defaults.dst = 0;
      // For theme, default to previous if available otherwise 1
      if (partial.theme === undefined) {
        if (prev && typeof prev.theme === 'number') defaults.theme = prev.theme;
        else defaults.theme = 1;
      }
      // merge defaults into partial (without overwriting any explicit values)
      const merged = { ...defaults, ...partial };
      log('Loaded state for', device.name, merged);
      this.maybePublishState(device.name, merged, true);
      // If any of the primary endpoints succeeded, mark the device as ONLINE; otherwise OFFLINE
      const primaryOk = brtData !== null || appData !== null;
      if (primaryOk) await this.maybePublishDeviceStatus(device.name, 'ONLINE');
      else await this.maybePublishDeviceStatus(device.name, 'OFFLINE');
    } catch (err: any) {
      warn('Failed to load device state for', device.name, err?.message || err);
      // On error, mark device offline
      await this.maybePublishDeviceStatus(device.name, 'OFFLINE');
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
