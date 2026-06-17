// src/dashboard.ts
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static('public'));
app.use(express.json());

// Config update endpoint
app.post('/api/config', (req, res) => {
  const { holdTime, slippage, buyAmount, minLiquidity } = req.body;
  // Update process.env or CONFIG object dynamically
  if (holdTime) process.env.HOLD_TIME_MS = holdTime;
  if (slippage) process.env.SLIPPAGE_BPS = slippage;
  res.json({ success: true });
});

// Emit trade events to dashboard
export function emitTrade(event: string, data: any) {
  io.emit(event, data);
}

httpServer.listen(3000, () => {
  console.log('📊 Dashboard running at http://localhost:3000');
});