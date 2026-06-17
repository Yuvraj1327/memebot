// src/executor.ts
import {
  PublicKey,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import axios from 'axios';
import { connection, wallet, CONFIG } from './config';

// ── Paper Trading State ───────────────────────────────────────────────────────
const PAPER_MODE = process.env.PAPER_TRADING === 'true';

interface PaperPosition {
  mint: string;
  solSpent: number;
  tokenAmount: number;
  entryPrice: number;
  buyTime: number;
}

const paperState = {
  solBalance: parseFloat(process.env.PAPER_BALANCE_SOL || '10'),
  positions:  new Map<string, PaperPosition>(),
  trades:     [] as any[],
  totalPnl:   0,
  wins:       0,
  losses:     0,
};

function paperLog(msg: string) {
  console.log(`📄 [PAPER] ${msg}`);
}

function printPaperStats() {
  console.log('\n' + '─'.repeat(50));
  console.log('📊 PAPER TRADING STATS');
  console.log('─'.repeat(50));
  console.log(`💰 SOL Balance  : ${paperState.solBalance.toFixed(4)} SOL`);
  console.log(`📈 Total Trades : ${paperState.trades.length}`);
  console.log(`✅ Wins         : ${paperState.wins}`);
  console.log(`❌ Losses       : ${paperState.losses}`);
  console.log(`💹 Total P&L    : ${paperState.totalPnl >= 0 ? '+' : ''}${paperState.totalPnl.toFixed(4)} SOL`);
  if (paperState.trades.length > 0) {
    const avgPnl = paperState.totalPnl / Math.max(paperState.wins + paperState.losses, 1);
    console.log(`📉 Avg P&L/trade: ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(4)} SOL`);
  }
  console.log('─'.repeat(50) + '\n');
}

// ── Price fetching ────────────────────────────────────────────────────────────
export async function getTokenPrice(tokenMint: PublicKey): Promise<number> {
  try {
    const res = await axios.get(
      `https://api.jup.ag/price/v2?ids=${tokenMint.toString()}`,
      { timeout: 5000 }
    );
    return res.data?.data?.[tokenMint.toString()]?.price ?? 0;
  } catch {
    return 0;
  }
}

// Simulate a price for brand-new pump.fun tokens (not yet on Jupiter price API)
async function getOrSimulatePrice(tokenMint: PublicKey): Promise<number> {
  const real = await getTokenPrice(tokenMint);
  if (real > 0) return real;

  // Simulate a starting price based on typical pump.fun launch
  // ~1B supply, ~0.003 SOL initial liquidity ≈ $0.000000003 per token
  const simulated = 0.000000003 * (0.8 + Math.random() * 0.4); // ±20% variance
  paperLog(`No price found — simulating entry price: $${simulated.toExponential(3)}`);
  return simulated;
}

// ── Real balance helpers (still useful for stats) ─────────────────────────────
export async function getWalletSOLBalance(): Promise<number> {
  if (PAPER_MODE) return paperState.solBalance;
  return (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL;
}

export async function getTokenRawAmount(tokenMint: PublicKey): Promise<number> {
  if (PAPER_MODE) {
    const pos = paperState.positions.get(tokenMint.toString());
    return pos ? pos.tokenAmount : 0;
  }
  try {
    const accounts = await connection.getParsedTokenAccountsByOwner(
      wallet.publicKey, { mint: tokenMint }
    );
    if (!accounts.value.length) return 0;
    return Number(accounts.value[0].account.data.parsed.info.tokenAmount.amount);
  } catch { return 0; }
}

// ── PAPER BUY ─────────────────────────────────────────────────────────────────
async function paperBuy(
  tokenMint: PublicKey
): Promise<{ success: boolean; txSig?: string; entryPrice?: number }> {
  const mintStr = tokenMint.toString();

  if (paperState.solBalance < CONFIG.BUY_AMOUNT_SOL + 0.002) {
    paperLog(`❌ Insufficient paper SOL: ${paperState.solBalance.toFixed(4)}`);
    return { success: false };
  }

  const entryPrice = await getOrSimulatePrice(tokenMint);

  // Simulate token amount received
  // pump.fun: ~1B total supply, bonding curve math simplified
  const solIn        = CONFIG.BUY_AMOUNT_SOL;
  const tokenAmount  = entryPrice > 0
    ? (solIn * 160) / entryPrice   // rough approximation
    : solIn * 1_000_000_000 * 0.01; // fallback: 1% of 1B supply

  // Deduct SOL
  paperState.solBalance -= (CONFIG.BUY_AMOUNT_SOL + 0.002); // +0.002 for fees

  // Record position
  paperState.positions.set(mintStr, {
    mint: mintStr,
    solSpent: CONFIG.BUY_AMOUNT_SOL,
    tokenAmount,
    entryPrice,
    buyTime: Date.now(),
  });

  const fakeSig = `PAPER_BUY_${mintStr.slice(0, 8)}_${Date.now()}`;

  paperLog(`✅ Bought ${mintStr.slice(0, 8)}...`);
  paperLog(`   SOL spent  : ${CONFIG.BUY_AMOUNT_SOL} SOL`);
  paperLog(`   Entry price: $${entryPrice.toExponential(4)}`);
  paperLog(`   Tokens got : ${tokenAmount.toLocaleString()}`);
  paperLog(`   Paper bal  : ${paperState.solBalance.toFixed(4)} SOL`);

  return { success: true, txSig: fakeSig, entryPrice };
}

// ── PAPER SELL ────────────────────────────────────────────────────────────────
async function paperSell(
  tokenMint: PublicKey,
  exitPrice: number
): Promise<{ success: boolean; txSig?: string }> {
  const mintStr = tokenMint.toString();
  const pos = paperState.positions.get(mintStr);

  if (!pos) {
    paperLog(`❌ No position found for ${mintStr.slice(0, 8)}...`);
    return { success: false };
  }

  // Calculate P&L
  const solReceived = pos.tokenAmount * exitPrice / 160; // reverse of buy calc
  const pnlSol      = solReceived - pos.solSpent;
  const pnlPct      = (pnlSol / pos.solSpent) * 100;
  const holdSeconds = ((Date.now() - pos.buyTime) / 1000).toFixed(0);

  // Update paper state
  paperState.solBalance += solReceived;
  paperState.totalPnl   += pnlSol;
  pnlSol >= 0 ? paperState.wins++ : paperState.losses++;

  // Record trade
  paperState.trades.push({
    mint:        mintStr,
    entryPrice:  pos.entryPrice,
    exitPrice,
    pnlSol,
    pnlPct,
    holdSeconds,
    timestamp:   new Date().toISOString(),
  });

  paperState.positions.delete(mintStr);

  const emoji = pnlSol >= 0 ? '🟢' : '🔴';
  paperLog(`${emoji} Sold ${mintStr.slice(0, 8)}...`);
  paperLog(`   Hold time  : ${holdSeconds}s`);
  paperLog(`   Entry      : $${pos.entryPrice.toExponential(4)}`);
  paperLog(`   Exit       : $${exitPrice.toExponential(4)}`);
  paperLog(`   P&L        : ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`);
  paperLog(`   Paper bal  : ${paperState.solBalance.toFixed(4)} SOL`);

  // Print stats every 5 trades
  if (paperState.trades.length % 5 === 0) printPaperStats();

  const fakeSig = `PAPER_SELL_${mintStr.slice(0, 8)}_${Date.now()}`;
  return { success: true, txSig: fakeSig };
}

// ── PUBLIC: executeBuy ────────────────────────────────────────────────────────
export async function executeBuy(
  tokenMint: PublicKey,
  _poolAddress: PublicKey
): Promise<{ success: boolean; txSig?: string; entryPrice?: number }> {
  if (PAPER_MODE) {
    paperLog(`🛒 Paper buying ${tokenMint.toString().slice(0, 8)}...`);
    return paperBuy(tokenMint);
  }

  // ── Real buy (pump.fun bonding curve) ────────────────────────────────────
  try {
    const { PublicKey: PK, VersionedTransaction, TransactionMessage,
            TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY,
            ComputeBudgetProgram } = await import('@solana/web3.js');
    const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction,
            TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = await import('@solana/spl-token');

    const PUMP_FUN_PROGRAM  = new PK('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
    const PUMP_FUN_FEE_ACCT = new PK('CebN5WGQ4jvEPvsVU4EoHEpgznyQHeSSyV5tU17KZyz9');
    const GLOBAL_STATE      = new PK('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5zP9QkMsA87B9fh');
    const EVENT_AUTH        = new PK('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp1F1');

    const [bondingCurve] = PK.findProgramAddressSync(
      [Buffer.from('bonding-curve'), tokenMint.toBuffer()], PUMP_FUN_PROGRAM
    );
    const [assocBondCurve] = PK.findProgramAddressSync(
      [bondingCurve.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), tokenMint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const userTokenAcct = await getAssociatedTokenAddress(tokenMint, wallet.publicKey);

    const amountLamports = Math.floor(CONFIG.BUY_AMOUNT_SOL * LAMPORTS_PER_SOL);
    const ixs: any[]    = [];

    const ataInfo = await connection.getAccountInfo(userTokenAcct);
    if (!ataInfo) {
      ixs.push(createAssociatedTokenAccountInstruction(
        wallet.publicKey, userTokenAcct, wallet.publicKey, tokenMint
      ));
    }

    const disc = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
    const data  = Buffer.alloc(24);
    disc.copy(data, 0);
    data.writeBigUInt64LE(BigInt(1_000_000_000), 8); // token amount (max)
    data.writeBigUInt64LE(BigInt(amountLamports), 16);

    ixs.push(new TransactionInstruction({
      programId: PUMP_FUN_PROGRAM,
      keys: [
        { pubkey: GLOBAL_STATE,       isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_FEE_ACCT,  isSigner: false, isWritable: true  },
        { pubkey: tokenMint,          isSigner: false, isWritable: false },
        { pubkey: bondingCurve,       isSigner: false, isWritable: true  },
        { pubkey: assocBondCurve,     isSigner: false, isWritable: true  },
        { pubkey: userTokenAcct,      isSigner: false, isWritable: true  },
        { pubkey: wallet.publicKey,   isSigner: true,  isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID,   isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: EVENT_AUTH,         isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_PROGRAM,   isSigner: false, isWritable: false },
      ],
      data,
    }));

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const msg = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CONFIG.PRIORITY_FEE_LAMPORTS }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        ...ixs,
      ],
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    tx.sign([wallet]);

    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');

    console.log(`✅ Buy confirmed: ${sig}`);
    await new Promise(r => setTimeout(r, 2000));
    const entryPrice = await getTokenPrice(tokenMint);
    return { success: true, txSig: sig, entryPrice: entryPrice || 0.000000001 };

  } catch (err: any) {
    console.error('❌ Buy failed:', err?.message ?? err);
    return { success: false };
  }
}

// ── PUBLIC: executeSell ───────────────────────────────────────────────────────
export async function executeSell(
  tokenMint: PublicKey,
  _hint?: number
): Promise<{ success: boolean; txSig?: string }> {
  if (PAPER_MODE) {
    paperLog(`💰 Paper selling ${tokenMint.toString().slice(0, 8)}...`);
    const exitPrice = await getOrSimulatePrice(tokenMint);
    return paperSell(tokenMint, exitPrice);
  }

  // real sell logic here (same as before)
  return { success: false };
}

// ── Export paper stats (for dashboard) ───────────────────────────────────────
export function getPaperStats() {
  return {
    solBalance: paperState.solBalance,
    totalTrades: paperState.trades.length,
    wins:   paperState.wins,
    losses: paperState.losses,
    totalPnl: paperState.totalPnl,
    recentTrades: paperState.trades.slice(-20),
    openPositions: Array.from(paperState.positions.values()),
  };
}