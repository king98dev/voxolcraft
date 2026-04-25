const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

// ── Data storage ──────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const WORLD_FILE    = path.join(DATA_DIR, 'world.json');

function loadJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data), 'utf8');
}

let accounts = loadJSON(ACCOUNTS_FILE, {});
let worldBlocks = loadJSON(WORLD_FILE, {});

function saveWorld() { saveJSON(WORLD_FILE, worldBlocks); }
function saveAccounts() { saveJSON(ACCOUNTS_FILE, accounts); }

// Auto-save world every 30s
setInterval(saveWorld, 30000);

// ── Auth helpers ──────────────────────────────────────────────────────────────
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha256').toString('hex');
}
function makeSalt() { return crypto.randomBytes(16).toString('hex'); }
function makeToken() { return crypto.randomBytes(24).toString('hex'); }

// token -> username map for active sessions
const sessions = {};

// ── World generation ──────────────────────────────────────────────────────────
const SEED = loadJSON(path.join(DATA_DIR, 'seed.json'), { v: Math.floor(Math.random() * 99999) }).v;
saveJSON(path.join(DATA_DIR, 'seed.json'), { v: SEED });

// Simple noise for terrain
function noise(x, z, seed) {
  let n = Math.sin(x * 0.3 + seed) * Math.cos(z * 0.3 + seed * 0.7) * 4;
  n += Math.sin(x * 0.1 + seed * 1.3) * Math.cos(z * 0.15 + seed) * 8;
  n += Math.sin(x * 0.05 + seed * 0.5) * Math.cos(z * 0.05 + seed * 1.1) * 12;
  return Math.floor(n);
}

// Block types: 0=air,1=grass,2=dirt,3=stone,4=wood,5=leaves,6=sand,7=water,8=coal,9=iron,10=gold,11=diamond,12=bedrock,13=planks,14=glass,15=brick
const BLOCK = { AIR:0,GRASS:1,DIRT:2,STONE:3,WOOD:4,LEAVES:5,SAND:6,WATER:7,COAL:8,IRON:9,GOLD:10,DIAMOND:11,BEDROCK:12,PLANKS:13,GLASS:14,BRICK:15 };

function getGeneratedBlock(x, y, z) {
  const key = `${x},${y},${z}`;
  if (worldBlocks[key] !== undefined) return worldBlocks[key];

  const baseH = 12 + noise(x, z, SEED);
  const caveH = noise(x * 2, z * 2, SEED + 999);

  if (y < 0) return BLOCK.BEDROCK;
  if (y === 0) return BLOCK.BEDROCK;
  if (y > baseH) {
    if (y <= 8 && y > baseH) return BLOCK.WATER;
    return BLOCK.AIR;
  }
  if (y === baseH) {
    if (y <= 8) return BLOCK.SAND;
    return BLOCK.GRASS;
  }
  if (y > baseH - 3) return BLOCK.DIRT;

  // Ores deep underground
  if (y < 5 && Math.abs(noise(x*3,z*3,SEED+111)) % 7 === 0) return BLOCK.DIAMOND;
  if (y < 10 && Math.abs(noise(x*3,z*3,SEED+222)) % 5 === 0) return BLOCK.GOLD;
  if (y < 15 && Math.abs(noise(x*3,z*3,SEED+333)) % 4 === 0) return BLOCK.IRON;
  if (y < 20 && Math.abs(noise(x*3,z*3,SEED+444)) % 3 === 0) return BLOCK.COAL;

  return BLOCK.STONE;
}

// Generate a chunk (16x64x16) of block data
function generateChunk(cx, cz) {
  const blocks = {};
  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      const wx = cx * 16 + lx;
      const wz = cz * 16 + lz;
      const baseH = 12 + noise(wx, wz, SEED);

      for (let y = 0; y <= Math.max(baseH, 8) + 1; y++) {
        const b = getGeneratedBlock(wx, y, wz);
        if (b !== BLOCK.AIR) blocks[`${wx},${y},${wz}`] = b;
      }

      // Trees
      if (baseH > 8 && Math.abs(noise(wx*7, wz*7, SEED+777)) % 9 === 0) {
        const th = 4 + (Math.abs(noise(wx,wz,SEED+888)) % 3);
        for (let ty = 1; ty <= th; ty++) blocks[`${wx},${baseH+ty},${wz}`] = BLOCK.WOOD;
        for (let lly = -1; lly <= 1; lly++)
          for (let llx = -2; llx <= 2; llx++)
            for (let llz = -2; llz <= 2; llz++)
              if (!(llx===0&&llz===0&&lly<=0))
                blocks[`${wx+llx},${baseH+th+lly},${wz+llz}`] = BLOCK.LEAVES;
      }
    }
  }
  return blocks;
}

// ── HTTP server — serves client.html ─────────────────────────────────────────
const CLIENT_PATH = path.join(__dirname, 'client.html');

const httpServer = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(CLIENT_PATH, (err, data) => {
      if (err) { res.writeHead(404); res.end('client.html not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

// Connected players: ws -> { username, x, y, z, yaw, pitch, health, inventory, hotbar }
const players = new Map();

function broadcast(data, exceptWs = null) {
  const msg = JSON.stringify(data);
  for (const [ws] of players) {
    if (ws !== exceptWs && ws.readyState === 1) ws.send(msg);
  }
}

function send(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── Account: register ──
      case 'register': {
        const { username, password } = msg;
        if (!username || !password || username.length < 2 || password.length < 4) {
          return send(ws, { type: 'auth_fail', reason: 'Username ≥2 chars, password ≥4 chars' });
        }
        if (accounts[username.toLowerCase()]) {
          return send(ws, { type: 'auth_fail', reason: 'Username already taken' });
        }
        const salt = makeSalt();
        const hash = hashPassword(password, salt);
        accounts[username.toLowerCase()] = {
          username, salt, hash,
          createdAt: Date.now(),
          inventory: {},
          hotbar: [BLOCK.PLANKS, BLOCK.GLASS, BLOCK.BRICK, 0, 0, 0, 0, 0, 0],
          spawnX: Math.floor(Math.random()*20)-10,
          spawnY: 20,
          spawnZ: Math.floor(Math.random()*20)-10,
        };
        saveAccounts();
        const token = makeToken();
        sessions[token] = username.toLowerCase();
        send(ws, { type: 'auth_ok', token, username, account: accounts[username.toLowerCase()] });
        break;
      }

      // ── Account: login ──
      case 'login': {
        const { username, password } = msg;
        const acc = accounts[username?.toLowerCase()];
        if (!acc) return send(ws, { type: 'auth_fail', reason: 'Account not found' });
        const hash = hashPassword(password, acc.salt);
        if (hash !== acc.hash) return send(ws, { type: 'auth_fail', reason: 'Wrong password' });
        const token = makeToken();
        sessions[token] = username.toLowerCase();
        send(ws, { type: 'auth_ok', token, username: acc.username, account: acc });
        break;
      }

      // ── Join world after login ──
      case 'join': {
        const { token } = msg;
        const ukey = sessions[token];
        if (!ukey) return send(ws, { type: 'error', reason: 'Invalid session' });
        const acc = accounts[ukey];

        const player = {
          username: acc.username,
          x: acc.spawnX, y: acc.spawnY, z: acc.spawnZ,
          yaw: 0, pitch: 0,
          health: 20,
          inventory: acc.inventory || {},
          hotbar: acc.hotbar || [0,0,0,0,0,0,0,0,0],
        };
        players.set(ws, player);

        // Send existing players
        const others = [];
        for (const [ows, op] of players) {
          if (ows !== ws) others.push({ username: op.username, x: op.x, y: op.y, z: op.z, yaw: op.yaw, pitch: op.pitch });
        }
        send(ws, { type: 'joined', player, others, seed: SEED });

        // Tell others about new player
        broadcast({ type: 'player_join', username: acc.username, x: player.x, y: player.y, z: player.z }, ws);

        // Send nearby chunks
        const cx = Math.floor(player.x / 16);
        const cz = Math.floor(player.z / 16);
        for (let dx = -3; dx <= 3; dx++) {
          for (let dz = -3; dz <= 3; dz++) {
            const chunkBlocks = generateChunk(cx+dx, cz+dz);
            // Merge saved blocks on top
            send(ws, { type: 'chunk', cx: cx+dx, cz: cz+dz, blocks: chunkBlocks });
          }
        }
        // Send all saved world modifications
        send(ws, { type: 'world_edits', blocks: worldBlocks });
        break;
      }

      // ── Player movement ──
      case 'move': {
        const p = players.get(ws);
        if (!p) return;
        p.x = msg.x; p.y = msg.y; p.z = msg.z;
        p.yaw = msg.yaw; p.pitch = msg.pitch;
        broadcast({ type: 'player_move', username: p.username, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch }, ws);
        break;
      }

      // ── Place/break block ──
      case 'set_block': {
        const p = players.get(ws);
        if (!p) return;
        const { x, y, z, block } = msg;
        const key = `${x},${y},${z}`;
        if (block === 0) delete worldBlocks[key];
        else worldBlocks[key] = block;
        broadcast({ type: 'set_block', x, y, z, block });
        break;
      }

      // ── Request chunk ──
      case 'get_chunk': {
        const { cx, cz } = msg;
        const chunkBlocks = generateChunk(cx, cz);
        send(ws, { type: 'chunk', cx, cz, blocks: chunkBlocks });
        send(ws, { type: 'world_edits', blocks: worldBlocks });
        break;
      }

      // ── Save inventory ──
      case 'save_inv': {
        const p = players.get(ws);
        if (!p) return;
        const ukey = Object.keys(accounts).find(k => accounts[k].username === p.username);
        if (ukey) {
          accounts[ukey].inventory = msg.inventory;
          accounts[ukey].hotbar = msg.hotbar;
          saveAccounts();
        }
        break;
      }

      // ── Chat ──
      case 'chat': {
        const p = players.get(ws);
        if (!p) return;
        const text = String(msg.text).slice(0, 120);
        broadcast({ type: 'chat', username: p.username, text });
        break;
      }
    }
  });

  ws.on('close', () => {
    const p = players.get(ws);
    if (p) {
      broadcast({ type: 'player_leave', username: p.username });
      players.delete(ws);
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`VoxelCraft running on port ${PORT}`));
