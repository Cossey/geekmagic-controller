export function log(...args: unknown[]) {
  console.log('[gm]', ...args);
}

export function warn(...args: unknown[]) {
  console.warn('[gm] WARN', ...args);
}

export function error(...args: unknown[]) {
  console.error('[gm] ERROR', ...args);
}
