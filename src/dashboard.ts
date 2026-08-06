import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getRecentTrades } from './logger';
import { getPaperStats, getWalletSOLBalance, resolveBuySolAmount, getSolUsdPrice } from './executor';
import { CONFIG, connection } from './config';
import { requireAuth, createNonce, verifySignature } from './walletauth';
import { getAllSettings, applySettingsUpdate } from './settingstore';
import { getRiskStatus, getStrategyStatus } from './riskmanager';
import type { BotControls, BotState } from './types';

const app = express();
const httpServer = createServer(app);

app.use(cors({ origin: '*' }));
app.use(express.json());

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ── APIs only — no HTML ───────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    status: 'MemeRush Bot Running ✅',
    uptime: Math.floor(process.uptime()) + 's',
    paper_mode: CONFIG.paperTrading,
    version: '1.0.0',
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/api/trades', (req, res) => {
  try {
    const mode = req.query.mode === 'paper' || req.query.mode === 'live' ? req.query.mode : undefined;
    res.json(getRecentTrades(50, mode));
  } catch { res.json([]); }
});

app.get('/api/stats', (_req, res) => {
  try { res.json(getPaperStats()); } catch { res.json({}); }
});

app.post('/api/config', (req, res) => {
  const { holdTime, slippage, buyAmount, minLiquidity, tpMin, tpMax } = req.body;
  if (holdTime)     process.env.HOLD_TIME_MS      = holdTime;
  if (slippage)     process.env.SLIPPAGE_BPS      = slippage;
  if (buyAmount)    process.env.BUY_AMOUNT_SOL    = buyAmount;
  if (minLiquidity) process.env.MIN_LIQUIDITY_SOL = minLiquidity;
  if (tpMin)        process.env.TAKE_PROFIT_MIN   = tpMin;
  if (tpMax)        process.env.TAKE_PROFIT_MAX   = tpMax;

  // Also persist + apply live (Settings Storage) so changes take effect
  // immediately and survive a restart, without changing this endpoint's response.
  applySettingsUpdate({
    HOLD_TIME_MS: holdTime,
    SLIPPAGE_BPS: slippage,
    BUY_AMOUNT_SOL: buyAmount,
    MIN_LIQUIDITY_SOL: minLiquidity,
    TAKE_PROFIT_MIN: tpMin,
    TAKE_PROFIT_MAX: tpMax,
  });

  res.json({ success: true });
});

// ── Bot state machine ─────────────────────────────────────────────────────────
// The bot ALWAYS boots stopped — no exceptions. It never resumes on its own
// after a page refresh, a backend restart/redeploy, a wallet (re)connection,
// or a Paper/Live mode switch. The ONLY thing that ever starts it is an
// explicit POST /bot/start from the user clicking "Start Bot".
let botState: BotState = 'stopped';

function setBotState(next: BotState) {
  botState = next;
  io.emit('botStatus', { state: botState, active: botState === 'running', ...getStrategyStatus() });
}

export function isBotActive() { return botState === 'running'; }
export function getBotState(): BotState { return botState; }

io.on('connection', () => console.log('📡 Client connected'));

export function emitTrade(event: string, data: any) {
  io.emit(event, data);
}

// ── Bot lifecycle hookup ──────────────────────────────────────────────────────
// index.ts calls setBotControls() once at boot so these routes can actually
// start/stop the detector and trigger an emergency sell of open positions,
// without dashboard.ts needing to import index/positionManager directly.
let controls: BotControls | null = null;
export function setBotControls(c: BotControls) {
  controls = c;
}

async function handleBotStart(_req: any, res: any) {
  if (!controls) return res.status(503).json({ error: 'Bot controls not ready yet' });

  // Live-mode validation (paper mode has no wallet-balance requirement — the
  // paper wallet manages its own balance and simply declines a buy it can't
  // afford). requireAuth on this route already guarantees a connected,
  // signature-verified operator wallet before we even get here.
  if (!CONFIG.paperTrading) {
    try {
      const [balance, required] = await Promise.all([getWalletSOLBalance(), resolveBuySolAmount()]);
      if (balance < required) {
        return res.status(400).json({
          error: 'Insufficient SOL Balance.',
          solBalance: balance,
          requiredSol: required,
        });
      }
    } catch (err: any) {
      return res.status(500).json({ error: `Could not validate wallet balance: ${err?.message ?? err}` });
    }
  }

  setBotState('starting');
  try {
    await controls.start();
  } catch (err: any) {
    // Previously uncaught: a throw here left botState stuck at 'starting'
    // forever, with no response ever sent back to the client.
    setBotState('stopped');
    return res.status(500).json({ error: `Failed to start bot: ${err?.message ?? err}` });
  }
  setBotState('running');
  res.json({ status: botState });
}

function handleBotStop(_req: any, res: any) {
  if (!controls) return res.status(503).json({ error: 'Bot controls not ready yet' });
  // Hard stop, per spec: scanning, buying, selling and every timer/interval
  // stop immediately (controls.stop() calls detector.stop() + clears every
  // position-monitor interval synchronously). There is nothing left running
  // afterward to "wait" for, so the state transitions directly to 'stopped' —
  // waiting here for open positions to reach 0 would deadlock forever, since
  // their monitoring was just deliberately cleared and nothing would ever
  // close them again until Start Bot or Emergency Sell.
  controls.stop();
  setBotState('stopped');
  res.json({ status: botState, openPositions: controls.getOpenPositionCount() });
}

function handleBotStatus(_req: any, res: any) {
  res.json({
    active: botState === 'running',
    state: botState,
    ...getStrategyStatus(),
  });
}

async function handleEmergencySell(_req: any, res: any) {
  if (!controls) return res.status(503).json({ error: 'Bot controls not ready yet' });
  setBotState('emergency_stop');
  try {
    const closed = await controls.emergencySell();
    io.emit('emergencySell', { closed, time: Date.now() });
    // Per spec: Emergency Sell is one of exactly two ways to stop the bot
    // (the other being Stop Bot). It always lands on 'stopped', never a
    // separate 'paused' state — there is no third state to resume from.
    setBotState('stopped');
    res.json({ success: true, closed, status: botState });
  } catch (err: any) {
    // Previously: botState stayed stuck at 'emergency_stop' forever on error,
    // since this branch never reset it back.
    setBotState('stopped');
    res.status(500).json({ success: false, error: err?.message });
  }
}

// Paper Trading must be completely independent of any wallet — but requireAuth
// was being applied unconditionally to Start/Stop/Emergency Sell, so those
// always 401'd in Paper mode with no wallet connected (visible directly as
// "POST /bot/start 401 (Unauthorized)" in the browser console). This skips
// the wallet-auth check entirely while in Paper mode; Live mode still
// requires a verified wallet, since that's genuinely authorizing real funds.
function requireAuthUnlessPaper(req: any, res: any, next: any) {
  if (CONFIG.paperTrading) return next();
  return requireAuth(req, res, next);
}

// Only three ways to change botState now: Start Bot, Stop Bot, Emergency Sell.
// The old pause/resume/toggle routes were a second, unvalidated path to the
// same state (resume skipped the live-mode balance check entirely; pause
// never actually stopped the detector or cleared monitoring intervals) —
// removed rather than left as latent duplicate logic.
app.post('/api/bot/start', requireAuthUnlessPaper, handleBotStart);
app.post('/api/bot/stop', requireAuthUnlessPaper, handleBotStop);
app.post('/api/emergency-sell', requireAuthUnlessPaper, handleEmergencySell);
app.get('/api/bot/status', handleBotStatus);

app.post('/bot/start', requireAuthUnlessPaper, handleBotStart);
app.post('/bot/stop', requireAuthUnlessPaper, handleBotStop);
app.post('/bot/emergency-sell', requireAuthUnlessPaper, handleEmergencySell);
app.get('/bot/status', handleBotStatus);

// ── Wallet authentication (Solana Wallet Standard — Phantom, Solflare, Backpack,
// Glow, Nightly, Coinbase Wallet, Trust Wallet, or any compliant wallet). The
// verification itself (ed25519 signature over a signed nonce) is wallet-agnostic
// by construction; `provider` is optional and only used for informational logging.
app.post('/api/auth/nonce', (req, res) => {
  const { publicKey } = req.body || {};
  if (!publicKey) return res.status(400).json({ error: 'publicKey required' });
  res.json({ message: createNonce(publicKey) });
});

app.post('/api/auth/verify', (req, res) => {
  const { publicKey, signature, provider } = req.body || {};
  if (!publicKey || !signature) {
    return res.status(400).json({ error: 'publicKey and signature required' });
  }
  const token = verifySignature(publicKey, signature, provider);
  if (!token) return res.status(401).json({ error: 'Signature verification failed' });
  res.json({ token, wallet: publicKey });
});

// ── Wallet balance / Portfolio ────────────────────────────────────────────────
app.get('/api/wallet/balance', async (_req, res) => {
  try {
    const solBalance = await getWalletSOLBalance();
    if (CONFIG.paperTrading) {
      return res.json({ solBalance, paperMode: true, requiredSol: null, sufficientForBuy: true });
    }
    const requiredSol = await resolveBuySolAmount();
    res.json({ solBalance, paperMode: false, requiredSol, sufficientForBuy: solBalance >= requiredSol });
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

// Looks up the SOL balance for ANY given public key (the operator's connected
// browser wallet, not the bot's own wallet) using the backend's own already-
// configured RPC connection. This exists because direct browser->public-RPC
// calls (api.mainnet-beta.solana.com) are commonly blocked/rate-limited or
// lack permissive CORS for POST requests — that was the actual root cause of
// a funded wallet displaying $0.00: the client-side fetch was failing
// silently and falling back to zero, not any error in the balance math.
app.get('/api/wallet/lookup/:address', async (req, res) => {
  try {
    const pubkey = new PublicKey(req.params.address);
    const lamports = await connection.getBalance(pubkey, 'confirmed');
    res.json({ solBalance: lamports / LAMPORTS_PER_SOL });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Invalid address or RPC error' });
  }
});

// Live SOL/USD price — used by the dashboard to render the *connected* wallet's
// balance in USD (primary) + SOL (secondary). Reuses the bot's own price source
// (the same one buy-sizing uses) rather than duplicating a price feed client-side.
app.get('/api/price/sol-usd', async (_req, res) => {
  try {
    const price = await getSolUsdPrice();
    res.json({ price });
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

app.get('/api/portfolio', (req, res) => {
  if (!controls) return res.json({ openPositions: [], openCount: 0 });
  const mode = req.query.mode === 'paper' || req.query.mode === 'live' ? req.query.mode : undefined;
  res.json(controls.getPortfolio(mode));
});

// ── Settings (read current live config + any persisted overrides) ────────────
app.get('/api/settings', (_req, res) => {
  res.json({
    current: CONFIG,
    persistedOverrides: getAllSettings(),
    ...getStrategyStatus(), // skipCount, currentSkipCounter, buyAmountUSD, todayTrades, remainingTrades, dailyLimitReached
  });
});

app.post('/api/settings', requireAuthUnlessPaper, (req, res) => {
  const updated = applySettingsUpdate(req.body || {});
  res.json({ success: true, current: updated, ...getStrategyStatus() });
});

// ── Risk status ────────────────────────────────────────────────────────────
app.get('/api/risk', (_req, res) => {
  res.json(getRiskStatus());
});

const PORT = Number(process.env.PORT) || 3000;
httpServer.listen(PORT, () => {
  console.log('📊 API running on port ' + PORT);
});






// Detected tokens store karo
const detectedTokens: any[] = [];

export function emitNewToken(mint: string, source: string) {
  const token = {
    mint,
    source,
    time: Date.now(),
  };
  detectedTokens.unshift(token);
  if (detectedTokens.length > 50) detectedTokens.pop();
  io.emit('newToken', token);
}

app.get('/api/tokens', (_req, res) => {
  res.json(detectedTokens);
});