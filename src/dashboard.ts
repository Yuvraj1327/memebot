import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { getRecentTrades } from './logger';
import { getPaperStats } from './executor';

const app = express();
const httpServer = createServer(app);

// CORS — allow Netlify + local
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  }
});

app.use(express.static('public'));
app.use(express.json());

app.post('/api/config', (req, res) => {
  const { holdTime, slippage, buyAmount, minLiquidity, tpMin, tpMax } = req.body;
  if (holdTime)     process.env.HOLD_TIME_MS     = holdTime;
  if (slippage)     process.env.SLIPPAGE_BPS     = slippage;
  if (buyAmount)    process.env.BUY_AMOUNT_SOL   = buyAmount;
  if (minLiquidity) process.env.MIN_LIQUIDITY_SOL = minLiquidity;
  if (tpMin)        process.env.TAKE_PROFIT_MIN  = tpMin;
  if (tpMax)        process.env.TAKE_PROFIT_MAX  = tpMax;
  console.log('⚙️ Config updated:', req.body);
  res.json({ success: true });
});

app.get('/api/trades', (_req, res) => {
  try { res.json(getRecentTrades(50)); }
  catch { res.json([]); }
});

app.get('/api/stats', (_req, res) => {
  try { res.json(getPaperStats()); }
  catch { res.json({}); }
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

let BOT_ACTIVE = true;
app.post('/api/bot/toggle', (_req, res) => {
  BOT_ACTIVE = !BOT_ACTIVE;
  io.emit('botStatus', { active: BOT_ACTIVE });
  res.json({ status: BOT_ACTIVE ? 'running' : 'paused' });
});
export function isBotActive() { return BOT_ACTIVE; }

io.on('connection', (socket) => {
  console.log('📡 Dashboard connected');
  socket.on('disconnect', () => console.log('📡 Dashboard disconnected'));
});

export function emitTrade(event: string, data: any) {
  io.emit(event, data);
}

const PORT = Number(process.env.PORT) || 3000;
httpServer.listen(PORT, () => {
  console.log('📊 Dashboard running on port ' + PORT);
});