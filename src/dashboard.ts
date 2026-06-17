// src/dashboard.ts
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { getRecentTrades } from './logger';
import { getPaperStats } from './executor';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

app.use(express.static('public'));
app.use(express.json());

// ── Config update ─────────────────────────────────────────────────────────────
app.post('/api/config', (req, res) => {
  const { holdTime, slippage, buyAmount, minLiquidity, tpMin, tpMax } = req.body;
  if (holdTime)      process.env.HOLD_TIME_MS       = holdTime;
  if (slippage)      process.env.SLIPPAGE_BPS        = slippage;
  if (buyAmount)     process.env.BUY_AMOUNT_SOL      = buyAmount;
  if (minLiquidity)  process.env.MIN_LIQUIDITY_SOL   = minLiquidity;
  if (tpMin)         process.env.TAKE_PROFIT_MIN     = tpMin;
  if (tpMax)         process.env.TAKE_PROFIT_MAX     = tpMax;
  console.log('⚙️  Config updated:', req.body);
  res.json({ success: true });
});

// ── Recent trades history ─────────────────────────────────────────────────────
app.get('/api/trades', (_req, res) => {
  try {
    const trades = getRecentTrades(50);
    res.json(trades);
  } catch {
    res.json([]);
  }
});

// ── Paper trading stats ───────────────────────────────────────────────────────
app.get('/api/stats', (_req, res) => {
  try {
    const stats = getPaperStats();
    res.json(stats);
  } catch {
    res.json({});
  }
});

// ── Health check (Render needs this to confirm service is up) ─────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('📡 Dashboard client connected');
  socket.on('disconnect', () => {
    console.log('📡 Dashboard client disconnected');
  });
});

// ── Emit trade events to all connected dashboards ────────────────────────────
export function emitTrade(event: string, data: any) {
  io.emit(event, data);
}

// ── Start server — use Render's PORT env var ──────────────────────────────────
const PORT = Number(process.env.PORT) || 3000;
httpServer.listen(PORT, () => {
  console.log(`📊 Dashboard running on port ${PORT}`);
});