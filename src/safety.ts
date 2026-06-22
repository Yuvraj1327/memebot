// src/safety.ts
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { connection, CONFIG } from './config';

export interface SafetyResult {
  passed: boolean;
  reason?: string;
  liquiditySOL?: number;
}

export async function runSafetyChecks(
  tokenMint: PublicKey,
  poolAddress: PublicKey
): Promise<SafetyResult> {
  try {

    // ── 1. Verify it's actually a token mint ─────────────────────────────────
    const mintAccountInfo = await connection.getAccountInfo(tokenMint);
    if (!mintAccountInfo) {
      return { passed: false, reason: 'Mint account does not exist' };
    }

    // Token mints are owned by the Token Program (or Token-2022)
    const TOKEN_PROGRAM    = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const TOKEN_2022       = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
    const ownerPubkey = mintAccountInfo.owner.toString();

    if (ownerPubkey !== TOKEN_PROGRAM && ownerPubkey !== TOKEN_2022) {
      return { passed: false, reason: `Not a token mint (owner: ${ownerPubkey.slice(0, 8)}...)` };
    }

    // Mint account data is 82 bytes for SPL tokens
    if (mintAccountInfo.data.length < 82) {
      return { passed: false, reason: 'Invalid mint account data length' };
    }

    // ── 2. Check liquidity (SOL balance of pool/mint area) ───────────────────
    const poolBalance = await connection.getBalance(poolAddress);
    const liquiditySOL = poolBalance / LAMPORTS_PER_SOL;

    if (liquiditySOL < CONFIG.MIN_LIQUIDITY_SOL) {
      return {
        passed: false,
        reason: `Insufficient liquidity: ${liquiditySOL.toFixed(6)} SOL < ${CONFIG.MIN_LIQUIDITY_SOL} SOL`,
      };
    }

    // ── 3. Check top holder concentration (honeypot check) ───────────────────
    try {
      const largestAccounts = await connection.getTokenLargestAccounts(tokenMint);

      if (largestAccounts.value.length > 0) {
        const supplyInfo = await connection.getTokenSupply(tokenMint);
        const totalSupply = Number(supplyInfo.value.amount);

        if (totalSupply > 0) {
          const topAmount = Number(largestAccounts.value[0].amount);
          const topHolderPct = (topAmount / totalSupply) * 100;

          if (topHolderPct > 90) {
            return {
              passed: false,
              reason: `Top holder owns ${topHolderPct.toFixed(1)}% — likely honeypot`,
            };
          }
        }
      }
    } catch {
      // Holder check failed — not a hard block, just warn
      console.warn(`⚠️  Could not check holder concentration for ${tokenMint.toString().slice(0, 8)}...`);
    }

    // ── 4. Check mint authority (can devs mint infinite tokens?) ─────────────
    try {
      const mintInfo = await connection.getParsedAccountInfo(tokenMint);
      const parsed = (mintInfo.value?.data as any)?.parsed?.info;

      if (parsed?.mintAuthority) {
        console.warn(`⚠️  Mint authority not revoked on ${tokenMint.toString().slice(0, 8)}...`);
        // Not a hard block — many legit tokens haven't revoked yet at launch
      }

      // Freeze authority is more dangerous
      if (parsed?.freezeAuthority) {
        return {
          passed: false,
          reason: 'Freeze authority active — dev can freeze your tokens',
        };
      }
    } catch {
      // Parse failed — skip this check
    }

    return { passed: true, liquiditySOL };

  } catch (err: any) {
    return {
      passed: false,
      reason: `Safety check error: ${err?.message || err}`,
    };
  }
}