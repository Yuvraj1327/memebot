import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { getRecentTrades } from './logger';
import { getPaperStats, getWalletSOLBalance } from './executor';
import { CONFIG } from './config';
import { requireAuth, createNonce, verifySignature } from './walletauth';
import { getAllSettings, applySettingsUpdate } from './settingstore';
import { getRiskStatus } from './riskmanager';
import type { BotControls } from './types';

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

let BOT_ACTIVE = true;
app.post('/api/bot/toggle', (_req, res) => {
  BOT_ACTIVE = !BOT_ACTIVE;
  io.emit('botStatus', { active: BOT_ACTIVE });
  res.json({ status: BOT_ACTIVE ? 'running' : 'paused' });
});
export function isBotActive() { return BOT_ACTIVE; }

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

app.post('/api/bot/start', requireAuth, async (_req, res) => {
  if (!controls) return res.status(503).json({ error: 'Bot controls not ready yet' });
  await controls.start();
  BOT_ACTIVE = true;
  io.emit('botStatus', { active: true, state: 'running' });
  res.json({ status: 'running' });
});

app.post('/api/bot/stop', requireAuth, (_req, res) => {
  if (!controls) return res.status(503).json({ error: 'Bot controls not ready yet' });
  controls.stop();
  BOT_ACTIVE = false;
  io.emit('botStatus', { active: false, state: 'stopped' });
  res.json({ status: 'stopped' });
});

app.post('/api/bot/pause', requireAuth, (_req, res) => {
  BOT_ACTIVE = false;
  io.emit('botStatus', { active: false, state: 'paused' });
  res.json({ status: 'paused' });
});

app.post('/api/bot/resume', requireAuth, (_req, res) => {
  BOT_ACTIVE = true;
  io.emit('botStatus', { active: true, state: 'running' });
  res.json({ status: 'running' });
});

app.post('/api/emergency-sell', requireAuth, async (_req, res) => {
  if (!controls) return res.status(503).json({ error: 'Bot controls not ready yet' });
  try {
    const closed = await controls.emergencySell();
    io.emit('emergencySell', { closed, time: Date.now() });
    res.json({ success: true, closed });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message });
  }
});

// ── Phantom Wallet authentication ─────────────────────────────────────────────
app.post('/api/auth/nonce', (req, res) => {
  const { publicKey } = req.body || {};
  if (!publicKey) return res.status(400).json({ error: 'publicKey required' });
  res.json({ message: createNonce(publicKey) });
});

app.post('/api/auth/verify', (req, res) => {
  const { publicKey, signature } = req.body || {};
  if (!publicKey || !signature) {
    return res.status(400).json({ error: 'publicKey and signature required' });
  }
  const token = verifySignature(publicKey, signature);
  if (!token) return res.status(401).json({ error: 'Signature verification failed' });
  res.json({ token, wallet: publicKey });
});

// ── Wallet balance / Portfolio ────────────────────────────────────────────────
app.get('/api/wallet/balance', async (_req, res) => {
  try {
    res.json({ solBalance: await getWalletSOLBalance() });
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
  res.json({ current: CONFIG, persistedOverrides: getAllSettings() });
});

app.post('/api/settings', requireAuth, (req, res) => {
  const updated = applySettingsUpdate(req.body || {});
  res.json({ success: true, current: updated });
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