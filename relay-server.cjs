/**
 * Tekken Web - Ad-Hoc WebSocket Relay Server
 * Facilitates peer-to-peer Ad-Hoc packet forwarding for PPSSPP WebAssembly.
 */
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 27312;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', service: 'tekken-adhoc-relay', time: Date.now() }));
});

const wss = new WebSocket.Server({ server });

// Map of rooms: roomName -> Set of WebSocket clients
const rooms = new Map();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const roomName = url.searchParams.get('room') || 'default_room';

  if (!rooms.has(roomName)) {
    rooms.set(roomName, new Set());
  }
  const room = rooms.get(roomName);
  room.add(ws);

  console.log(`[RELAY] Nuevo jugador conectado a sala [${roomName}]. Total jugadores en sala: ${room.size}`);

  ws.on('message', (message, isBinary) => {
    // Forward every message/packet to all other peers in the room
    for (const peer of room) {
      if (peer !== ws && peer.readyState === WebSocket.OPEN) {
        peer.send(message, { binary: isBinary });
      }
    }
  });

  ws.on('close', () => {
    room.delete(ws);
    console.log(`[RELAY] Jugador desconectado de sala [${roomName}]. Restantes: ${room.size}`);
    if (room.size === 0) {
      rooms.delete(roomName);
    }
  });

  ws.on('error', (err) => {
    console.warn(`[RELAY ERR] Error en socket: ${err.message}`);
  });
});

server.listen(PORT, () => {
  console.log(`⚡ [TEKKEN RELAY] Servidor puente WebSocket corriendo en puerto ${PORT}`);
});
