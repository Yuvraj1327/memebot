// src/detector.ts
import { PublicKey, Connection } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { connection } from './config';
import axios from 'axios';

const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

const BLACKLIST = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'So11111111111111111111111111111111111111112',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
]);

export class TokenDetector extends EventEmitter {
  private seen = new Set<string>();
  private running = false;
  private lastSignature: string | null = null;
  private tradeCount = 0;
  private readonly MAX_TRADES = parseInt(process.env.MAX_TRADES || '20');

  incrementTrade() {
    this.tradeCount++;
    console.log('📊 Trade: ' + this.tradeCount + '/' + this.MAX_TRADES);
  }

  canTrade(): boolean {
    return this.tradeCount < this.MAX_TRADES;
  }

  async start() {
    console.log('🔍 Starting detector (HTTP polling mode)...');
    console.log('📊 Max trades: ' + this.MAX_TRADES);
    this.running = true;
    this.poll();
  }

  private async poll() {
    while (this.running) {
      try {
        await this.checkNewTokens();
      } catch (err: any) {
        console.warn('⚠️ Poll error:', err?.message);
      }
      // 10 second interval — Helius quota safe
      await new Promise(r => setTimeout(r, 10_000));
    }
  }

  private async checkNewTokens() {
    // Get recent transactions from pump.fun program
    const options: any = {
      limit: 5,
      commitment: 'confirmed',
    };

    if (this.lastSignature) {
      options.until = this.lastSignature;
    }

    const sigs = await connection.getSignaturesForAddress(
      PUMP_FUN_PROGRAM,
      options
    );

    if (!sigs || sigs.length === 0) return;

    // Save latest signature for next poll
    if (!this.lastSignature) {
      this.lastSignature = sigs[0].signature;
      console.log('📍 Starting from signature: ' + sigs[0].signature.slice(0, 16));
      return; // First run — just save position
    }

    this.lastSignature = sigs[0].signature;

    // Process each new transaction
    for (const sig of sigs.reverse()) {
      if (sig.err) continue;

      await new Promise(r => setTimeout(r, 500)); // small delay

      const mint = await this.extractMintFromTx(sig.signature);
      if (mint) {
        this.emitOnce(mint, sig.signature, 'pump.fun');
      }
    }
  }

  private emitOnce(mint: PublicKey, signature: string, source: string) {
    const key = mint.toString();
    if (BLACKLIST.has(key)) return;
    if (this.seen.has(key)) return;

    this.seen.add(key);
    setTimeout(() => this.seen.delete(key), 120_000);

    console.log('🚨 [' + source + '] New token: ' + key.slice(0, 16) + '...');
    this.emit('newToken', { mint, signature, source });
  }

  private async extractMintFromTx(signature: string): Promise<PublicKey | null> {
    try {
      const tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (!tx?.meta?.postTokenBalances?.length) return null;

      const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
      const TOKEN_2022    = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

      for (const bal of tx.meta.postTokenBalances) {
        const mint = bal.mint;
        if (BLACKLIST.has(mint)) continue;
        if (!bal.uiTokenAmount.uiAmount && bal.uiTokenAmount.uiAmount !== 0) continue;

        try {
          const mintPubkey = new PublicKey(mint);
          const info = await connection.getAccountInfo(mintPubkey);
          if (!info) continue;
          const owner = info.owner.toString();
          if (owner !== TOKEN_PROGRAM && owner !== TOKEN_2022) continue;
          if (info.data.length < 82) continue;
          return mintPubkey;
        } catch { continue; }
      }
    } catch { }
    return null;
  }

  stop() {
    this.running = false;
    console.log('🛑 Detector stopped');
  }
}