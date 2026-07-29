// src/settingsStore.ts
// Persists bot settings to SQLite (reusing the same DB file as trades) and
// applies them to the live, mutable CONFIG object so changes take effect
// immediately without a restart.
import { db } from './logger';
import { CONFIG } from './config';

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Keys that must be parsed back to numbers when loaded/applied
const NUMERIC_KEYS = new Set([
  'BUY_AMOUNT_SOL',
  'HOLD_TIME_MS',
  'HOLD_TIME_MOMENTUM_MS',
  'TAKE_PROFIT_MIN',
  'TAKE_PROFIT_MAX',
  'MOMENTUM_THRESHOLD',
  'SLIPPAGE_BPS',
  'MIN_LIQUIDITY_SOL',
  'PRIORITY_FEE_LAMPORTS',
  // Skip-buy strategy / daily limit / $ sizing
  'skipCount',
  'dailyTradeLimit',
  'buyAmountUSD',
]);

// Keys that must be parsed back to booleans when loaded/applied
const BOOLEAN_KEYS = new Set(['autoResumeNextDay', 'paperTrading']);

export function setSetting(key: string, value: string | number) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
  ).run(key, String(value));
}

export function getSetting(key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as any;
  return row?.value;
}

export function getAllSettings(): Record<string, string> {
  const rows = db.prepare(`SELECT key, value FROM settings`).all() as any[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/** Call once at boot, before the bot starts trading, to restore any settings
 *  that were previously saved via the dashboard. */
export function loadPersistedSettings() {
  const saved = getAllSettings();
  let count = 0;
  for (const [key, value] of Object.entries(saved)) {
    if (key in CONFIG) {
      if (NUMERIC_KEYS.has(key)) (CONFIG as any)[key] = parseFloat(value);
      else if (BOOLEAN_KEYS.has(key)) (CONFIG as any)[key] = value === 'true';
      else (CONFIG as any)[key] = value;
      count++;
    }
  }
  if (count > 0) console.log(`⚙️  Loaded ${count} persisted setting(s) from DB`);
}

/** Apply a partial update to CONFIG immediately and persist it. Unknown/undefined
 *  keys are ignored so this is safe to call with a raw request body. */
export function applySettingsUpdate(update: Record<string, any>) {
  for (const [key, value] of Object.entries(update)) {
    if (value === undefined || value === null || value === '') continue;
    if (!(key in CONFIG)) continue;

    let parsed: any = value;
    if (NUMERIC_KEYS.has(key)) {
      parsed = parseFloat(value);
      if (Number.isNaN(parsed)) continue;
    } else if (BOOLEAN_KEYS.has(key)) {
      parsed = value === true || value === 'true';
    }

    (CONFIG as any)[key] = parsed;
    setSetting(key, parsed);
  }
  return { ...CONFIG };
}