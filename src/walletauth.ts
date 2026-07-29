// src/walletAuth.ts
// Authentication for ANY wallet implementing the Solana Wallet Standard
// (Phantom, Solflare, Backpack, Glow, Nightly, Coinbase Wallet, Trust Wallet,
// or any other compliant wallet) via the standard "sign a nonce" flow:
//   1) frontend calls POST /api/auth/nonce { publicKey } -> gets a message
//   2) the connected wallet signs it via the Wallet Standard's
//      `solana:signMessage` feature (same call shape across all wallets)
//   3) frontend calls POST /api/auth/verify { publicKey, signature, provider? }
//   4) we verify the ed25519 signature against the wallet's own public key —
//      this check is identical regardless of which wallet produced it, so
//      nothing here is or ever was Phantom-specific — and issue a session
//      token used as a Bearer token on control endpoints.
//
// Requires the `tweetnacl` package (npm install tweetnacl) — bs58 is already
// a dependency of this project (used in config.ts).
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { db } from './logger';
import { randomToken } from './utils';

db.exec(`
  CREATE TABLE IF NOT EXISTS wallets (
    address TEXT PRIMARY KEY,
    first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL
  );
`);

// `last_provider` is informational only (which wallet extension the user
// picked — Phantom/Solflare/Backpack/...); it plays no role in verification.
function ensureColumn(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn('wallets', 'last_provider', 'last_provider TEXT');

const NONCE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const pendingNonces = new Map<string, { message: string; expires: number }>();

export function createNonce(address: string): string {
  const message =
    `MemeRush Bot — sign in\n` +
    `Wallet: ${address}\n` +
    `Nonce: ${randomToken(12)}\n` +
    `Issued: ${new Date().toISOString()}`;

  pendingNonces.set(address, { message, expires: Date.now() + NONCE_TTL_MS });
  return message;
}

/**
 * Verifies a signed nonce from ANY Solana Wallet Standard wallet and, if
 * valid, issues a session token. `provider` is an optional, free-form label
 * (e.g. "Phantom", "Solflare", "Backpack") supplied by the frontend purely
 * for display/logging — it is never used in the verification decision.
 */
export function verifySignature(address: string, signatureB58: string, provider?: string): string | null {
  const entry = pendingNonces.get(address);
  if (!entry || entry.expires < Date.now()) return null;

  try {
    const message = new TextEncoder().encode(entry.message);
    const signature = bs58.decode(signatureB58);
    const pubkey = bs58.decode(address);
    if (!nacl.sign.detached.verify(message, signature, pubkey)) return null;
  } catch {
    return null;
  }

  pendingNonces.delete(address);

  db.prepare(
    `INSERT INTO wallets (address, last_login, last_provider) VALUES (?, CURRENT_TIMESTAMP, ?)
     ON CONFLICT(address) DO UPDATE SET last_login = CURRENT_TIMESTAMP, last_provider = excluded.last_provider`
  ).run(address, provider ?? null);

  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare(`INSERT INTO sessions (token, address, expires_at) VALUES (?, ?, ?)`).run(
    token,
    address,
    expiresAt
  );

  console.log(`🔑 Wallet authenticated: ${address.slice(0, 8)}...${provider ? ` via ${provider}` : ''}`);

  return token;
}

export function getSessionWallet(token: string | undefined): string | null {
  if (!token) return null;
  const row = db.prepare(`SELECT address, expires_at FROM sessions WHERE token = ?`).get(token) as any;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row.address;
}

/** Express middleware: protects control endpoints behind any connected, verified wallet. */
export function requireAuth(req: any, res: any, next: any) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : undefined;
  const walletAddress = getSessionWallet(token);
  if (!walletAddress) {
    return res.status(401).json({ error: 'Unauthorized — connect a Solana wallet first' });
  }
  req.wallet = walletAddress;
  next();
}

export function listWallets() {
  return db.prepare(`SELECT address, first_seen, last_login, last_provider FROM wallets ORDER BY last_login DESC`).all();
}