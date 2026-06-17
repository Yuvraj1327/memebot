import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { getRecentTrades } from './logger';
import { getPaperStats } from './executor';

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

const PORT = Number(process.env.PORT) || 3000;
httpServer.listen(PORT, () => {
  console.log('📊 API running on port ' + PORT);
});