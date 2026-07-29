import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { getRecentTrades } from './logger';
import { getPaperStats, getWalletSOLBalance, resolveBuySolAmount, getSolUsdPrice } from './executor';
import { CONFIG } from './config';
import { requireAuth, createNonce, verifySignature } from './walletauth';
import { getAllSettings, applySettingsUpdate } from './settingstore';
import { getRiskStatus, getStrategyStatus, clearManualHalt } from './riskmanager';
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
  res.json({ status: 'MemeRush Bot Running', uptime: process.uptime() });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/api/trades', (_req, res) => {
  try { res.json(getRecentTrades(50)); } catch { res.json([]); }
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
  await controls.start();
  setBotState('running');
  res.json({ status: botState });
}

// Watches open positions after Stop is requested, so they're managed to
// completion instead of abandoned — the bot only reports fully 'stopped'
// once every open position has closed.
let stopWatcher: NodeJS.Timeout | null = null;
function watchForFullyStopped() {
  if (stopWatcher) clearInterval(stopWatcher);
  stopWatcher = setInterval(() => {
    if (!controls) return;
    if (controls.getOpenPositionCount() === 0) {
      if (stopWatcher) clearInterval(stopWatcher);
      stopWatcher = null;
      setBotState('stopped');
    }
  }, 3000);
}

function handleBotStop(_req: any, res: any) {
  if (!controls) return res.status(503).json({ error: 'Bot controls not ready yet' });
  controls.stop(); // stops new-token scanning/buying immediately; open positions keep being managed

  if (controls.getOpenPositionCount() > 0) {
    setBotState('stopping'); // still selling down existing positions
    watchForFullyStopped();
  } else {
    setBotState('stopped');
  }
  res.json({ status: botState, openPositions: controls.getOpenPositionCount() });
}

function handleBotPause(_req: any, res: any) {
  setBotState('paused');
  res.json({ status: botState });
}

function handleBotResume(_req: any, res: any) {
  clearManualHalt(); // relevant when autoResumeNextDay=false and the limit had halted buying
  setBotState('running');
  res.json({ status: botState });
}

async function handleEmergencySell(_req: any, res: any) {
  if (!controls) return res.status(503).json({ error: 'Bot controls not ready yet' });
  try {
    setBotState('emergency_stop');
    const closed = await controls.emergencySell();
    io.emit('emergencySell', { closed, time: Date.now() });
    // Emergency sell intentionally does NOT auto-resume buying — an operator
    // must explicitly call resume, same as a manual pause.
    setBotState('paused');
    res.json({ success: true, closed, status: botState });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message });
  }
}

function handleBotStatus(_req: any, res: any) {
  res.json({
    active: botState === 'running',
    state: botState,
    ...getStrategyStatus(),
  });
}

// Existing /api/bot/* paths (unchanged behavior/response shape) ...
app.post('/api/bot/toggle', (_req, res) => {
  setBotState(botState === 'running' ? 'paused' : 'running');
  res.json({ status: botState === 'running' ? 'running' : 'paused' });
});
app.post('/api/bot/start', requireAuth, handleBotStart);
app.post('/api/bot/stop', requireAuth, handleBotStop);
app.post('/api/bot/pause', requireAuth, handleBotPause);
app.post('/api/bot/resume', requireAuth, handleBotResume);
app.post('/api/emergency-sell', requireAuth, handleEmergencySell);
app.get('/api/bot/status', handleBotStatus);

// ... plus bare /bot/* aliases (spec asked for these exact paths). Same handlers,
// no duplicated logic — just mounted on a second path for compatibility.
app.post('/bot/start', requireAuth, handleBotStart);
app.post('/bot/stop', requireAuth, handleBotStop);
app.post('/bot/pause', requireAuth, handleBotPause);
app.post('/bot/resume', requireAuth, handleBotResume);
app.post('/bot/emergency-sell', requireAuth, handleEmergencySell);
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

app.get('/api/portfolio', (_req, res) => {
  if (!controls) return res.json({ openPositions: [], openCount: 0 });
  res.json(controls.getPortfolio());
});

// ── Settings (read current live config + any persisted overrides) ────────────
app.get('/api/settings', (_req, res) => {
  res.json({
    current: CONFIG,
    persistedOverrides: getAllSettings(),
    ...getStrategyStatus(), // skipCount, currentSkipCounter, buyAmountUSD, todayTrades, remainingTrades, dailyLimitReached
  });
});

app.post('/api/settings', requireAuth, (req, res) => {
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


app.get('/', (_req, res) => {
  res.json({ 
    status: 'MemeRush Bot Running ✅', 
    uptime: Math.floor(process.uptime()) + 's',
    paper_mode: process.env.PAPER_TRADING === 'true',
    version: '1.0.0'
  });
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