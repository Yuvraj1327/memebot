// src/utils.ts
import crypto from 'crypto';

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export function shortAddr(addr: string, len = 8): string {
  return addr.length > len ? `${addr.slice(0, len)}...` : addr;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

export function safeDivide(a: number, b: number, fallback = 0): number {
  return b === 0 ? fallback : a / b;
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export async function retry<T>(
  fn: () => Promise<T>,
  attempts = 2,
  delayMs = 3000
): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(delayMs);
    }
  }
  throw lastErr;
}