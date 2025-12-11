import axios, { AxiosResponse } from 'axios';
import http from 'http';
import https from 'https';
import FormData from 'form-data';
import { log, warn } from './logger';

// Use non-keepalive agents to avoid leaving sockets open in tests/short-lived processes
const agentOptions = { keepAlive: false };
const client = axios.create({
  timeout: 5000,
  httpAgent: new http.Agent(agentOptions),
  httpsAgent: new https.Agent(agentOptions),
});

export async function sendGet(url: string): Promise<AxiosResponse | null> {
  try {
    log('HTTP GET', url);
    const res = await client.get(url);
    log('HTTP OK', res.status, res.statusText);
    return res;
  } catch (err: any) {
    warn('HTTP request failed', err?.message || err);
    return null;
  }
}

export async function getJson(url: string): Promise<any | null> {
  try {
    log('HTTP GET JSON', url);
    const res = await client.get(url);
    return res.data;
  } catch (err: any) {
    warn('HTTP request failed', err?.message || err);
    return null;
  }
}

export async function postBinary(url: string, data: Buffer, contentType = 'application/octet-stream'): Promise<boolean> {
  try {
    log('HTTP POST BINARY', url, 'contentType', contentType);
    const res = await client.request({
      url,
      method: 'POST',
      data,
      headers: { 'Content-Type': contentType },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    log('HTTP POST OK', res.status);
    return true;
  } catch (err: any) {
    warn('HTTP POST failed', err?.message || err);
    return false;
  }
}

export async function postForm(url: string, fieldName: string, buffer: Buffer, filename: string, contentType = 'application/octet-stream'): Promise<boolean> {
  try {
    const form = new FormData();
    form.append(fieldName, buffer, { filename, contentType });
    const headers = form.getHeaders();
    log('HTTP POST FORM', url, 'file', filename);
    const res = await client.request({
      url,
      method: 'POST',
      data: form,
      headers: { ...headers },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    log('HTTP POST FORM OK', res.status);
    return true;
  } catch (err: any) {
    const msg = String(err?.message || err || '');
    const body = String(err?.response?.data || '');
    // Some device firmwares return an annoying "Duplicate Content-Length" (with or without
    // hyphen) or Node error code 'ERR_RESPONSE_HEADERS_MULTIPLE_CONTENT_LENGTH' even though the
    // upload actually succeeds. Treat those cases as success but warn for diagnostics.
    const dupRe = /duplicate.*content[- ]?length/i;
    if (dupRe.test(msg) || dupRe.test(body) || err?.code === 'ERR_RESPONSE_HEADERS_MULTIPLE_CONTENT_LENGTH' || String(err?.message || '').includes('ERR_RESPONSE_HEADERS_MULTIPLE_CONTENT_LENGTH')) {
      warn('HTTP POST FORM duplicate/multiple content-length - treating as success', msg || String(err));
      return true;
    }
    warn('HTTP POST FORM failed', msg);
    return false;
  }
}
