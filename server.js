// server.js
const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const os = require('os');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// เสิร์ฟไฟล์หน้าเว็บจาก ./public
app.use(express.static(path.join(__dirname, 'public')));

// health check
app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
const rooms = {}; // { [roomName]: { roomCode, players: { [socketId]: {...} }, bullets: [] } }

// จุดเกิดแบบสุ่ม
function randomSpawn() {
  return { x: Math.floor(80 + Math.random() * 640), y: Math.floor(80 + Math.random() * 440) };
}

/* ===== REST APIs ===== */
app.post('/createRoom', (req, res) => {
  const { roomName, roomCode } = req.body || {};
  if (!roomName || !roomCode || !/^\d{4}$/.test(String(roomCode))) {
    return res.status(400).json({ success: false, error: 'ข้อมูลห้องไม่ถูกต้อง' });
  }
  if (rooms[roomName]) {
    return res.status(400).json({ success: false, error: 'ห้องนี้มีอยู่แล้ว' });
  }
  rooms[roomName] = { roomCode: String(roomCode), players: {}, bullets: [] };
  res.json({ success: true });
});

app.post('/login', (req, res) => {
  const { username, roomName, roomCode } = req.body || {};
  if (!username || String(username).length < 3 || !roomName || !roomCode) {
    return res.status(400).json({ success: false, error: 'ข้อมูลไม่ครบหรือไม่ถูกต้อง' });
  }
  const room = rooms[roomName];
  if (!room) return res.status(400).json({ success: false, error: 'ไม่พบห้องนี้' });
  if (room.roomCode !== String(roomCode)) return res.status(400).json({ success: false, error: 'รหัสห้องไม่ถูกต้อง' });
  for (const id in room.players) {
    if (room.players[id].username === username) {
      return res.status(400).json({ success: false, error: 'ชื่อผู้เล่นนี้มีคนใช้แล้วในห้อง' });
    }
  }
  res.json({ success: true });
});

/* ===== Game utils ===== */
function sanitizePlayers(playersObj) {
  const out = {};
  for (const id in playersObj) {
    const p = playersObj[id];
    out[id] = { username: p.username, x: +p.x || 0, y: +p.y || 0, angle: +p.angle || 0, hp: +p.hp || 0, dead: !!p.dead };
  }
  return out;
}

function updateBullets(room) {
  const speed = 12;
  const toRemove = [];
  room.bullets.forEach((b, i) => {
    b.x += b.dx * speed; b.y += b.dy * speed;
    if (b.x < 0 || b.x > 800 || b.y < 0 || b.y > 600) { toRemove.push(i); return; }
    for (const id in room.players) {
      const p = room.players[id];
      if (!p || p.dead) continue;
      const dx = b.x - p.x, dy = b.y - p.y;
      if (dx*dx + dy*dy < 20*20 && b.ownerId !== id) {
        p.hp -= 25;
        if (p.hp <= 0 && !p.dead) {
          p.dead = true; p.hp = 0;
          io.to(id).emit('dead');
          p.respawnTimer = setTimeout(() => {
            p.dead = false; p.hp = 100;
            const pos = randomSpawn(); p.x = pos.x; p.y = pos.y;
            io.to(id).emit('respawn', { x: p.x, y: p.y, hp: p.hp });
          }, 4000);
        }
        toRemove.push(i); break;
      }
    }
  });
  toRemove.reverse().forEach(i => room.bullets.splice(i,1));
  if (room.bullets.length > 1000) room.bullets.splice(0, room.bullets.length - 1000);
}

function findPlayerRoom(socketId) {
  for (const rn in rooms) if (rooms[rn].players[socketId]) return rn;
  return null;
}

/* ===== Socket.IO ===== */
io.on('connection', socket => {
  console.log('connect', socket.id);

  socket.on('joinRoom', ({ username, roomName, roomCode }) => {
    const room = rooms[roomName];
    if (!room || room.roomCode !== String(roomCode)) { socket.emit('errorMsg', 'ไม่พบห้องหรือรหัสไม่ถูกต้อง'); return; }
    for (const id in room.players) {
      if (room.players[id].username === username) { socket.emit('errorMsg', 'ชื่อผู้เล่นนี้มีคนใช้แล้วในห้อง'); return; }
    }
    socket.join(roomName);
    const spawn = randomSpawn();
    room.players[socket.id] = { username, x: spawn.x, y: spawn.y, angle: 0, hp: 100, dead: false, respawnTimer: null };
    io.to(roomName).emit('playersUpdate', sanitizePlayers(room.players));
    socket.emit('registered', socket.id);
    socket.emit('gameState', { players: sanitizePlayers(room.players), bullets: room.bullets });
  });

  socket.on('playerMove', data => {
    const rn = findPlayerRoom(socket.id); if (!rn) return;
    const room = rooms[rn]; const p = room.players[socket.id]; if (!p || p.dead) return;
    const nx = Number(data.x), ny = Number(data.y), na = Number(data.angle);
    if (Number.isFinite(nx)) p.x = Math.max(0, Math.min(800, nx));
    if (Number.isFinite(ny)) p.y = Math.max(0, Math.min(600, ny));
    if (Number.isFinite(na)) p.angle = na;
    if (data.isShooting) {
      const dx = Math.cos(p.angle), dy = Math.sin(p.angle);
      room.bullets.push({ x: p.x + dx*18, y: p.y + dy*18, dx, dy, ownerId: socket.id });
    }
    io.to(rn).emit('playersUpdate', sanitizePlayers(room.players));
  });

  socket.on('respawnRequest', () => {
    const rn = findPlayerRoom(socket.id); if (!rn) return;
    const room = rooms[rn]; const p = room.players[socket.id]; if (!p) return;
    if (p.dead) {
      if (p.respawnTimer) clearTimeout(p.respawnTimer);
      p.dead = false; p.hp = 100;
      const pos = randomSpawn(); p.x = pos.x; p.y = pos.y;
      io.to(socket.id).emit('respawn', { x: p.x, y: p.y, hp: p.hp });
      io.to(rn).emit('playersUpdate', sanitizePlayers(room.players));
    }
  });

  socket.on('chat message', msg => {
    const rn = findPlayerRoom(socket.id); if (!rn) return;
    const uname = rooms[rn].players[socket.id]?.username || 'Player';
    io.to(rn).emit('chat message', { username: uname, message: String(msg).slice(0, 500) });
  });

  socket.on('disconnect', () => {
    for (const rn in rooms) {
      const room = rooms[rn];
      if (room.players[socket.id]) {
        if (room.players[socket.id].respawnTimer) clearTimeout(room.players[socket.id].respawnTimer);
        delete room.players[socket.id];
        io.to(rn).emit('playersUpdate', sanitizePlayers(room.players));
        if (Object.keys(room.players).length === 0) delete rooms[rn];
        break;
      }
    }
    console.log('disconnect', socket.id);
  });
});

/* ===== Game loop ===== */
setInterval(() => {
  for (const rn in rooms) {
    const room = rooms[rn];
    updateBullets(room);
    io.to(rn).emit('gameState', { players: sanitizePlayers(room.players), bullets: room.bullets });
  }
}, 1000/30);

/* ===== Listen on all IPs + log LAN URLs ===== */
function getAllLocalIPs() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name in ifaces) for (const it of ifaces[name]) if (it.family==='IPv4' && !it.internal) out.push(it.address);
  return out.length ? out : ['localhost'];
}
server.listen(PORT, '0.0.0.0', () => {
  console.log('Server listening:');
  getAllLocalIPs().forEach(ip => console.log(`  -> http://${ip}:${PORT}`));
});
