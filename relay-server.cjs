/**
 * Tekken Web - Full Coldbird PRO Ad-Hoc Relay Server over WebSocket
 * Supports: LOGIN, SCAN, CONNECT, DISCONNECT, CHAT, PING & P2P Data Forwarding
 */
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 27312;

// Opcodes
const OPCODE_PING = 0;
const OPCODE_LOGIN = 1;
const OPCODE_CONNECT = 2;
const OPCODE_DISCONNECT = 3;
const OPCODE_SCAN = 4;
const OPCODE_SCAN_COMPLETE = 5;
const OPCODE_CONNECT_BSSID = 6;
const OPCODE_CHAT = 7;

function macToStr(buf) {
  if (!buf || buf.length < 6) return '00:00:00:00:00:00';
  return Array.from(buf.subarray(0, 6)).map(b => b.toString(16).padStart(2, '0')).join(':');
}

function createAdhocServer(existingHttpServer = null, wsPort = PORT) {
  let server = existingHttpServer;
  let wss;

  if (server) {
    wss = new WebSocket.Server({ server });
  } else {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'online', service: 'coldbird-adhoc-relay', time: Date.now() }));
    });
    wss = new WebSocket.Server({ server });
    server.listen(wsPort, () => {
      console.log(`⚡ [ADHOC RELAY] Servidor Ad-Hoc WebSocket activo en puerto ${wsPort}`);
    });
  }

  let nextClientNum = 1;
  const clients = new Set();

  wss.on('connection', (ws, req) => {
    const clientNum = nextClientNum++;
    const virtualIp = 0x7F000000 | (clientNum & 0xFF); // 127.0.0.X

    const client = {
      ws,
      id: clientNum,
      virtualIp,
      mac: Buffer.alloc(6),
      name: Buffer.alloc(128),
      nick: `Player_${clientNum}`,
      game: 'ULES00356', // Tekken DR default
      group: null,
      lastPing: Date.now()
    };

    clients.add(client);
    console.log(`[ADHOC] [+] Nuevo cliente conectado #${client.id} (IP asignada: 127.0.0.${clientNum & 0xFF})`);

    ws.on('message', (data, isBinary) => {
      if (!Buffer.isBuffer(data)) {
        data = Buffer.from(data);
      }
      if (data.length < 1) return;

      const opcode = data[0];

      // 1. PING (0)
      if (opcode === OPCODE_PING) {
        client.lastPing = Date.now();
        return;
      }

      // 2. LOGIN (1) - 144 bytes expected (opcode(1) + mac(6) + name(128) + game(9))
      if (opcode === OPCODE_LOGIN) {
        if (data.length >= 7) {
          data.copy(client.mac, 0, 1, 7);
        }
        if (data.length >= 135) {
          data.copy(client.name, 0, 7, 135);
          client.nick = client.name.toString('utf8').replace(/\0/g, '').trim() || `Player_${client.id}`;
        }
        if (data.length >= 144) {
          client.game = data.subarray(135, 144).toString('ascii').replace(/\0/g, '').trim();
        }
        console.log(`[ADHOC] 🎮 LOGIN: "${client.nick}" [MAC: ${macToStr(client.mac)}] Juego: ${client.game}`);
        return;
      }

      // 3. SCAN (4) - Request list of rooms/groups
      if (opcode === OPCODE_SCAN) {
        console.log(`[ADHOC] 🔍 SCAN solicitado por "${client.nick}"`);
        // Find distinct active groups in this game
        const groups = new Map();
        for (const peer of clients) {
          if (peer !== client && peer.game === client.game && peer.group) {
            if (!groups.has(peer.group)) {
              groups.set(peer.group, peer.mac);
            }
          }
        }

        // Send SCAN results
        for (const [groupName, hostMac] of groups.entries()) {
          const scanPkt = Buffer.alloc(15);
          scanPkt[0] = OPCODE_SCAN;
          Buffer.from(groupName).copy(scanPkt, 1, 0, 8);
          hostMac.copy(scanPkt, 9, 0, 6);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(scanPkt, { binary: true });
          }
        }

        // Send SCAN_COMPLETE (5)
        const completePkt = Buffer.from([OPCODE_SCAN_COMPLETE]);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(completePkt, { binary: true });
        }
        return;
      }

      // 4. CONNECT (2) - Join room/group (opcode(1) + group(8))
      if (opcode === OPCODE_CONNECT) {
        const groupName = data.length >= 9 
          ? data.subarray(1, 9).toString('ascii').replace(/\0/g, '').trim() || 'default'
          : 'default';
        client.group = groupName;
        console.log(`[ADHOC] ⚔️ "${client.nick}" entró a sala [${client.group}]`);

        // Find existing host or peers in group
        let hostMac = client.mac;
        for (const peer of clients) {
          if (peer !== client && peer.group === client.group && peer.game === client.game) {
            hostMac = peer.mac;

            // Notify peer about the new client (S2C Connect Packet: 139 bytes)
            const notifyPeer = Buffer.alloc(139);
            notifyPeer[0] = OPCODE_CONNECT;
            client.name.copy(notifyPeer, 1, 0, 128);
            client.mac.copy(notifyPeer, 129, 0, 6);
            notifyPeer.writeUInt32BE(client.virtualIp, 135);
            if (peer.ws.readyState === WebSocket.OPEN) {
              peer.ws.send(notifyPeer, { binary: true });
            }

            // Notify new client about the existing peer
            const notifyClient = Buffer.alloc(139);
            notifyClient[0] = OPCODE_CONNECT;
            peer.name.copy(notifyClient, 1, 0, 128);
            peer.mac.copy(notifyClient, 129, 0, 6);
            notifyClient.writeUInt32BE(peer.virtualIp, 135);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(notifyClient, { binary: true });
            }
          }
        }

        // Send BSSID to new client (7 bytes: opcode(6) + hostMac(6))
        const bssidPkt = Buffer.alloc(7);
        bssidPkt[0] = OPCODE_CONNECT_BSSID;
        hostMac.copy(bssidPkt, 1, 0, 6);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(bssidPkt, { binary: true });
        }
        return;
      }

      // 5. DISCONNECT (3) - Leave room
      if (opcode === OPCODE_DISCONNECT) {
        if (client.group) {
          console.log(`[ADHOC] 👋 "${client.nick}" salió de sala [${client.group}]`);
          const discPkt = Buffer.alloc(5);
          discPkt[0] = OPCODE_DISCONNECT;
          discPkt.writeUInt32BE(client.virtualIp, 1);
          for (const peer of clients) {
            if (peer !== client && peer.group === client.group && peer.ws.readyState === WebSocket.OPEN) {
              peer.ws.send(discPkt, { binary: true });
            }
          }
          client.group = null;
        }
        return;
      }

      // 6. CHAT (7) - Broadcast chat in group
      if (opcode === OPCODE_CHAT) {
        for (const peer of clients) {
          if (peer !== client && peer.group === client.group && peer.ws.readyState === WebSocket.OPEN) {
            peer.ws.send(data, { binary: isBinary });
          }
        }
        return;
      }

      // 7. General packet relay (PTP / PDP combat gameplay data)
      for (const peer of clients) {
        if (peer !== client && peer.ws.readyState === WebSocket.OPEN) {
          if (!client.group || peer.group === client.group) {
            peer.ws.send(data, { binary: isBinary });
          }
        }
      }
    });

    ws.on('close', () => {
      clients.delete(client);
      console.log(`[ADHOC] [-] Jugador desconectado "${client.nick}" (#${client.id}). Restantes: ${clients.size}`);
      if (client.group) {
        const discPkt = Buffer.alloc(5);
        discPkt[0] = OPCODE_DISCONNECT;
        discPkt.writeUInt32BE(client.virtualIp, 1);
        for (const peer of clients) {
          if (peer.group === client.group && peer.ws.readyState === WebSocket.OPEN) {
            peer.ws.send(discPkt, { binary: true });
          }
        }
      }
    });

    ws.on('error', (err) => {
      console.warn(`[ADHOC ERR] #${client.id}: ${err.message}`);
    });
  });

  return { server, wss };
}

if (require.main === module) {
  createAdhocServer(null, PORT);
}

module.exports = { createAdhocServer };
