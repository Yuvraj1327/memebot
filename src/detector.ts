// src/detector.ts
import { Connection, PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { connection } from './config';

// ── Program IDs ──────────────────────────────────────────────────────────────
const PUMP_FUN_PROGRAM    = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const RAYDIUM_AMM         = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const RAYDIUM_CPMM        = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');

// Known stablecoins / non-memecoins to ignore
const BLACKLIST = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'So11111111111111111111111111111111111111112',    // wSOL
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
]);

export class TokenDetector extends EventEmitter {
  private subIds: number[]   = [];
  private seen = new Set<string>(); // dedup cache
  private seenTTL = 60_000;        // forget after 60s

  async start() {
    console.log('🔍 Starting token detector...');

    // ── 1. Pump.fun new token launches ───────────────────────────────────────
    const pumpSub = connection.onLogs(
      PUMP_FUN_PROGRAM,
      async (logInfo) => {
        if (logInfo.err) return;

        const isCreate = logInfo.logs.some(l =>
          l.includes('Instruction: Create') ||
          l.includes('Program log: create')
        );
        if (!isCreate) return;

        const mint = await this.extractMintFromTx(logInfo.signature);
        if (mint) this.emitOnce(mint, logInfo.signature, 'pump.fun');
      },
      'confirmed'
    );

    // ── 2. Raydium AMM new pool (token "graduates" from pump.fun or new launch)
    const raySub = connection.onLogs(
      RAYDIUM_AMM,
      async (logInfo) => {
        if (logInfo.err) return;

        const isNewPool = logInfo.logs.some(l =>
          l.includes('initialize2') ||
          l.includes('Instruction: Initialize')
        );
        if (!isNewPool) return;

        const mint = await this.extractMintFromTx(logInfo.signature);
        if (mint) this.emitOnce(mint, logInfo.signature, 'raydium-amm');
      },
      'confirmed'
    );

    // ── 3. Raydium CPMM (newer pool type) ────────────────────────────────────
    const cpmmSub = connection.onLogs(
      RAYDIUM_CPMM,
      async (logInfo) => {
        if (logInfo.err) return;

        const isNewPool = logInfo.logs.some(l =>
          l.includes('initialize') ||
          l.includes('CreatePool')
        );
        if (!isNewPool) return;

        const mint = await this.extractMintFromTx(logInfo.signature);
        if (mint) this.emitOnce(mint, logInfo.signature, 'raydium-cpmm');
      },
      'confirmed'
    );

    this.subIds = [pumpSub, raySub, cpmmSub];
    console.log('✅ Watching pump.fun + Raydium AMM + Raydium CPMM');
  }

  // ── Emit each mint only once per 60s ─────────────────────────────────────
  private emitOnce(mint: PublicKey, signature: string, source: string) {
    const key = mint.toString();

    // Skip blacklisted tokens
    if (BLACKLIST.has(key)) return;

    // Skip duplicates
    if (this.seen.has(key)) return;
    this.seen.add(key);
    setTimeout(() => this.seen.delete(key), this.seenTTL);

    console.log(`🚨 [${source}] New token: ${key}`);
    this.emit('newToken', { mint, signature, source });
  }

  // ── Pull the token mint from transaction post-balances ───────────────────
  private async extractMintFromTx(signature: string): Promise<PublicKey | null> {
  try {
    // Add small delay — tx may not be fully confirmed yet
    await new Promise(r => setTimeout(r, 800));

    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });

    if (!tx?.meta?.postTokenBalances?.length) return null;

    const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const TOKEN_2022    = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

    for (const bal of tx.meta.postTokenBalances) {
      const mint = bal.mint;

      // Skip blacklisted
      if (BLACKLIST.has(mint)) continue;

      // Must have some token amount
      if (!bal.uiTokenAmount.uiAmount && bal.uiTokenAmount.uiAmount !== 0) continue;

      // Verify the mint account is actually owned by Token Program
      try {
        const mintPubkey = new PublicKey(mint);
        const info = await connection.getAccountInfo(mintPubkey);
        if (!info) continue;

        const owner = info.owner.toString();
        if (owner !== TOKEN_PROGRAM && owner !== TOKEN_2022) continue;
        if (info.data.length < 82) continue;

        return mintPubkey;
      } catch {
        continue;
      }
    }
  } catch {
    // silently skip
  }
  return null;
}

  stop() {
    this.subIds.forEach(id => {
      try { connection.removeOnLogsListener(id); } catch {}
    });
    this.subIds = [];
    console.log('🛑 Detector stopped');
  }
}





