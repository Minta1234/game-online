// server.js (updated)
const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const os = require('os');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

// เสิร์ฟ static จาก ./public
const staticDir = path.join(__dirname, 'public');
app.use(express.static(staticDir));

// health check
app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
const rooms = {};

function randomSpawn() {
  return { x: Math.floor(80 + Math.random() * 640), y: Math.floor(80 + Math.random() * 440) };
}

app.post('/createRoom', (req, res) => {
  const { roomName, roomCode } = req.body;
  if (!roomName || !roomCode || !/^\d{4}$/.test(String(roomCode))) {
    return res.status(400).json({ success: false, error: 'ข้อมูลห้องไม่ถูกต้อง' });
  }
  if (rooms[roomName]) return res.status(400).json({ success: false, error: 'ห้องนี้มีอยู่แล้ว' });

  rooms[roomName] = { roomCode: String(roomCode), players: {}, bullets: [] };
  return res.json({ success: true });
});

app.post('/login', (req, res) => {
  const { username, roomName, roomCode } = req.body;
  if (!username || username.length < 3 || !roomName || !roomCode) {
    return res.status(400).json({ success: false, error: 'ข้อมูลไม่ครบหรือไม่ถูกต้อง' });
  }
  const room = rooms[roomName];
  if (!room) return res.status(400).json({ success: false, error: 'ไม่พบห้องนี้' });
  if (room.roomCode !== String(roomCode)) return res.status(400).json({ success: false, error: 'รหัสห้องไม่ถูกต้อง' });

  for (const id in room.players) if (room.players[id].username === username)
    return res.status(400).json({ success: false, error: 'ชื่อผู้เล่นนี้มีคนใช้แล้วในห้อง' });

  return res.json({ success: true });
});

// sanitize players
function sanitizePlayers(playersObj) {
  const out = {};
  for (const id in playersObj) {
    const p = playersObj[id];
    out[id] = {
      username: p.username,
      x: Number(p.x) || 0,
      y: Number(p.y) || 0,
      angle: Number(p.angle) || 0,
      hp: Number(p.hp) || 0,
      dead: !!p.dead
    };
  }
  return out;
}

function updateBullets(room) {
  const speed = 12;
  const toRemove = [];
  room.bullets.forEach((b, i) => {
    b.x += b.dx * speed;
    b.y += b.dy * speed;
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
        toRemove.push(i);
        break;
      }
    }
  });
  toRemove.reverse().forEach(i => room.bullets.splice(i,1));
}

io.on('connection', socket => {
  console.log('connect', socket.id);

  socket.on('joinRoom', ({ username, roomName, roomCode }) => {
    const room = rooms[roomName];
    if (!room || room.roomCode !== String(roomCode)) {
      socket.emit('errorMsg', 'ไม่พบห้องหรือรหัสไม่ถูกต้อง');
      return;
    }
    for (const id in room.players) if (room.players[id].username === username) {
      socket.emit('errorMsg', 'ชื่อผู้เล่นนี้มีคนใช้แล้วในห้อง'); return;
    }

    socket.join(roomName);
    const spawn = randomSpawn();
    room.players[socket.id] = { username, x: spawn.x, y: spawn.y, angle: 0, hp: 100, dead: false, respawnTimer: null };

    io.to(roomName).emit('playersUpdate', sanitizePlayers(room.players));
    socket.emit('registered', socket.id);
    socket.emit('gameState', { players: sanitizePlayers(room.players), bullets: room.bullets });
  });

  socket.on('playerMove', data => {
    let playerRoom = null;
    for (const rn in rooms) if (rooms[rn].players[socket.id]) { playerRoom = rn; break; }
    if (!playerRoom) return;
    const room = rooms[playerRoom];
    const p = room.players[socket.id];
    if (!p || p.dead) return;

    // sanitize incoming
    p.x = Number(data.x) || p.x;
    p.y = Number(data.y) || p.y;
    p.angle = Number(data.angle) || p.angle;
    if (data.isShooting) {
      const dx = Math.cos(p.angle), dy = Math.sin(p.angle);
      room.bullets.push({ x: p.x + dx*18, y: p.y + dy*18, dx, dy, ownerId: socket.id });
    }
    io.to(playerRoom).emit('playersUpdate', sanitizePlayers(room.players));
  });

  socket.on('chat message', msg => {
    let playerRoom = null;
    for (const rn in rooms) if (rooms[rn].players[socket.id]) { playerRoom = rn; break; }
    if (!playerRoom) return;
    const uname = rooms[playerRoom].players[socket.id].username || 'Player';
    io.to(playerRoom).emit('chat message', { username: uname, message: String(msg) });
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

// game loop 30 FPS
setInterval(() => {
  for (const rn in rooms) {
    const room = rooms[rn];
    updateBullets(room);
    io.to(rn).emit('gameState', { players: sanitizePlayers(room.players), bullets: room.bullets });
  }
}, 1000/30);

// แสดง URL ด้วย IP ภายใน LAN
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name in interfaces) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`Server listening on http://${ip}:${PORT}`);
});
