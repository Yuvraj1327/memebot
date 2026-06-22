// src/safety.ts
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { connection, CONFIG } from './config';
import axios from 'axios';

export interface SafetyResult {
  passed: boolean;
  reason?: string;
  liquiditySOL?: number;
  liquidityUSD?: number;
}

// ── DexScreener check — FREE, no API key ─────────────────────────────────────
async function getDexScreenerData(mint: string): Promise<{
  liquidityUSD: number;
  volume24h: number;
  priceChange5m: number;
  dexId: string;
} | null> {
  try {
    const res = await axios.get(
      'https://api.dexscreener.com/latest/dex/tokens/' + mint,
      { timeout: 5000 }
    );

    const pairs = res.data?.pairs;
    if (!pairs || pairs.length === 0) return null;

    // Best pair lo — highest liquidity wala
    const best = pairs.sort((a: any, b: any) =>
      (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
    )[0];

    return {
      liquidityUSD:  best.liquidity?.usd    || 0,
      volume24h:     best.volume?.h24        || 0,
      priceChange5m: best.priceChange?.m5    || 0,
      dexId:         best.dexId             || '',
    };
  } catch {
    return null; // DexScreener fail hone pe hard block nahi
  }
}

// ── Main safety check ─────────────────────────────────────────────────────────
export async function runSafetyChecks(
  tokenMint: PublicKey,
  poolAddress: PublicKey
): Promise<SafetyResult> {
  try {

    // ── 1. Valid token mint check ─────────────────────────────────────────────
    const mintAccountInfo = await connection.getAccountInfo(tokenMint);
    if (!mintAccountInfo) {
      return { passed: false, reason: 'Mint account does not exist' };
    }

    const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const TOKEN_2022    = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
    const owner = mintAccountInfo.owner.toString();

    if (owner !== TOKEN_PROGRAM && owner !== TOKEN_2022) {
      return { passed: false, reason: 'Not a valid token mint' };
    }

    if (mintAccountInfo.data.length < 82) {
      return { passed: false, reason: 'Invalid mint data' };
    }

    // ── 2. Basic SOL liquidity check (fast) ──────────────────────────────────
    const poolBalance  = await connection.getBalance(poolAddress);
    const liquiditySOL = poolBalance / LAMPORTS_PER_SOL;

    if (liquiditySOL < CONFIG.MIN_LIQUIDITY_SOL) {
      return {
        passed: false,
        reason: 'Low SOL liquidity: ' + liquiditySOL.toFixed(6) + ' SOL',
      };
    }

    // ── 3. DexScreener check (free, no key needed) ───────────────────────────
    const dex = await getDexScreenerData(tokenMint.toString());

    if (dex) {
      console.log(
        '📊 DexScreener: $' + dex.liquidityUSD.toFixed(0) +
        ' liq | Vol: $' + dex.volume24h.toFixed(0) +
        ' | 5m: ' + dex.priceChange5m.toFixed(1) + '%'
      );

      // Liquidity bahut kam — likely rug
      if (dex.liquidityUSD > 0 && dex.liquidityUSD < 500) {
        return {
          passed: false,
          reason: 'DexScreener liquidity too low: $' + dex.liquidityUSD.toFixed(0),
        };
      }

      // Price already 1000% upar — too late to snipe
      if (dex.priceChange5m > 1000) {
        return {
          passed: false,
          reason: 'Already pumped ' + dex.priceChange5m.toFixed(0) + '% in 5min — too late',
        };
      }
    } else {
      // DexScreener pe nahi mila — naya token hai (pump.fun pe hai)
      // Yeh actually GOOD hai — fresh launch
      console.log('ℹ️  Not on DexScreener yet — fresh pump.fun launch');
    }

    // ── 4. Freeze authority check ─────────────────────────────────────────────
    try {
      const mintInfo = await connection.getParsedAccountInfo(tokenMint);
      const parsed   = (mintInfo.value?.data as any)?.parsed?.info;

      if (parsed?.freezeAuthority) {
        return {
          passed: false,
          reason: 'Freeze authority active — dev can freeze tokens',
        };
      }

      if (parsed?.mintAuthority) {
        console.warn('⚠️  Mint authority not revoked');
      }
    } catch { }

    // ── 5. Top holder check ───────────────────────────────────────────────────
    try {
      const largest    = await connection.getTokenLargestAccounts(tokenMint);
      const supplyInfo = await connection.getTokenSupply(tokenMint);
      const total      = Number(supplyInfo.value.amount);

      if (total > 0 && largest.value.length > 0) {
        const topPct = (Number(largest.value[0].amount) / total) * 100;
        if (topPct > 90) {
          return {
            passed: false,
            reason: 'Top holder owns ' + topPct.toFixed(1) + '% — honeypot',
          };
        }
      }
    } catch { }

    return { passed: true, liquiditySOL };

  } catch (err: any) {
    return {
      passed: false,
      reason: 'Safety error: ' + (err?.message || err),
    };
  }
}