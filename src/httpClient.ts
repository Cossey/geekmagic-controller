import axios, { AxiosResponse } from 'axios';
import { log, warn } from './logger';

const client = axios.create({ timeout: 5000 });

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
