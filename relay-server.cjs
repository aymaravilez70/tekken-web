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

const macToVirtualIp = new Map();
let nextIpSuffix = 10;

function getVirtualIpForMac(macBuf) {
  const macKey = macToStr(macBuf);
  if (macKey === '00:00:00:00:00:00') {
    return 0x7F00000A; // 127.0.0.10 fallback
  }
  if (!macToVirtualIp.has(macKey)) {
    const suffix = nextIpSuffix++;
    if (nextIpSuffix > 240) nextIpSuffix = 10;
    const ip = 0x7F000000 | (suffix & 0xFF);
    macToVirtualIp.set(macKey, ip);
    console.log(`[ADHOC] 📌 IP fija asignada para MAC ${macKey} -> 127.0.0.${suffix}`);
  }
  return macToVirtualIp.get(macKey);
}

function getVirtualIpStrForMac(macInput) {
  if (!macInput) return '';
  let buf;
  if (Buffer.isBuffer(macInput)) {
    buf = macInput;
  } else if (typeof macInput === 'string') {
    const parts = macInput.split(':').map(h => parseInt(h, 16) || 0);
    buf = Buffer.from(parts.slice(0, 6));
  } else {
    return '';
  }
  const ipInt = getVirtualIpForMac(buf);
  return `127.0.0.${ipInt & 0xFF}`;
}

function createAdhocServer(existingHttpServer = null, wsPort = PORT) {
  let server = existingHttpServer;
  let wss;

  if (server) {
    wss = new WebSocket.Server({ server, handleProtocols: () => 'binary' });
  } else {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'online', service: 'coldbird-adhoc-relay', time: Date.now() }));
    });
    wss = new WebSocket.Server({ server, handleProtocols: () => 'binary' });
    server.listen(wsPort, () => {
      console.log(`⚡ [ADHOC RELAY] Servidor Ad-Hoc WebSocket activo en puerto ${wsPort}`);
    });
  }

  const clients = new Set();

  wss.on('connection', (ws, req) => {
    const client = {
      ws,
      id: 10,
      virtualIp: 0x7F00000A,
      mac: Buffer.alloc(6),
      name: Buffer.alloc(128),
      nick: 'Player',
      game: 'ULES00356', // Tekken DR default
      group: null,
      lastPing: Date.now()
    };

    clients.add(client);
    console.log(`[ADHOC] [+] Nuevo cliente conectado`);

    ws.on('message', (data, isBinary) => {
      if (!Buffer.isBuffer(data)) {
        data = Buffer.from(data);
      }
      if (data.length < 1) return;

      // Handle Emscripten SOCKFS handshake header [255, 255, 255, 255, 'p', 'o', 'r', 't', ...]
      if (data.length === 10 && data[0] === 255 && data[1] === 255 && data[2] === 255 && data[3] === 255) {
        console.log(`[ADHOC] 🤝 Emscripten SOCKFS handshake recibido para #${client.id}`);
        return;
      }

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
          client.virtualIp = getVirtualIpForMac(client.mac);
          client.id = client.virtualIp & 0xFF;

          // Close and remove any existing stale client with the same MAC:
          for (const existing of clients) {
            if (existing !== client && macToStr(existing.mac) === macToStr(client.mac)) {
              console.log(`[ADHOC] 🔄 Reemplazando sesión anterior para MAC ${macToStr(client.mac)}`);
              try { existing.ws.close(); } catch (e) {}
              clients.delete(existing);
            }
          }
        }
        if (data.length >= 135) {
          data.copy(client.name, 0, 7, 135);
          client.nick = client.name.toString('utf8').replace(/\0/g, '').trim() || `Player_${client.id}`;
        }
        if (data.length >= 144) {
          client.game = data.subarray(135, 144).toString('ascii').replace(/\0/g, '').trim();
        }
        console.log(`[ADHOC] 🎮 LOGIN: "${client.nick}" [MAC: ${macToStr(client.mac)}] IP: 127.0.0.${client.id} Juego: ${client.game}`);
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

  // Start P2P Data Relay on port 10555 for direct player-to-player match packets
  startP2PRelay(10555);

  return { server, wss };
}

const OPCODES = {
  0: 'PING',
  1: 'HELLO',
  2: 'JOIN (Solicitud de Pelea)',
  3: 'ACCEPT (Aceptó Pelea)',
  4: 'CANCEL',
  5: 'BULK',
  6: 'BULK_ABORT',
  7: 'BIRTH',
  8: 'DEATH',
  9: 'BYE'
};

function startP2PRelay(port = 10555) {
  let wss;
  try {
    wss = new WebSocket.Server({ port, handleProtocols: () => 'binary' });
    const peers = new Set();
    const cachedHelloByMac = new Map(); // senderMac -> Buffer

    wss.on('connection', (ws, req) => {
      let target = '';
      let senderMac = '';
      try {
        const urlObj = new URL(req.url, 'http://127.0.0.1:10555');
        target = urlObj.searchParams.get('target') || '';
        senderMac = urlObj.searchParams.get('mac') || '';
      } catch(e) {}

      const senderIp = senderMac ? getVirtualIpStrForMac(senderMac) : '';
      ws.target = target;
      ws.senderMac = senderMac;
      ws.senderIp = senderIp;

      peers.add(ws);
      console.log(`[P2P 10555] [+] Peer conectado: MAC=${senderMac || 'anon'} IP=${senderIp || '?'} -> Target=${target || 'all'} (Total peers: ${peers.size})`);

      // 1. Send Emscripten SOCKFS port handshake to the newly connected peer
      const portHandshake = Buffer.from([255, 255, 255, 255, 112, 111, 114, 116, (port & 0xFF00) >> 8, port & 0xFF]);
      ws.send(portHandshake, { binary: true });

      // 2. Replay cached player card HELLO to the newcomer immediately (< 10ms)
      for (const [otherMac, helloData] of cachedHelloByMac.entries()) {
        if (otherMac !== senderMac && helloData.length > 5 && ws.readyState === WebSocket.OPEN) {
          const otherIp = getVirtualIpStrForMac(otherMac);
          // If socket is targeted, only send matching opponent's HELLO
          if (!target || target === otherIp) {
            console.log(`[P2P 10555] ⚡ Reenviando perfil HELLO previo de ${otherMac} (${helloData.length} bytes) a nuevo peer`);
            ws.send(helloData, { binary: true });
          }
        }
      }

      ws.on('message', (msg, isBinary) => {
        if (!Buffer.isBuffer(msg)) msg = Buffer.from(msg);

        // Filter out incoming Emscripten SOCKFS port handshake headers
        if (msg.length === 10 && msg[0] === 255 && msg[1] === 255 && msg[2] === 255 && msg[3] === 255) {
          return;
        }

        const opcode = msg.length > 0 ? msg[0] : -1;
        const opName = OPCODES[opcode] || 'DATA';

        // 1. Drop dummy initial HELLO (length <= 5) without player profile
        if (opcode === 1 && msg.length <= 5) {
          return;
        }

        // 2. Cache real HELLO with Player Profile (length > 5, typically 221 bytes)
        if (opcode === 1) {
          if (ws.senderMac) {
            cachedHelloByMac.set(ws.senderMac, msg);
          }
          console.log(`[P2P 10555] 👤 Perfil HELLO transmitido de ${ws.senderMac || ws.senderIp || 'peer'} (${msg.length} bytes)`);
        } else if (opcode === 2) {
          console.log(`[P2P 10555] ⚔️ ¡SOLICITUD DE PELEA ENVIADA! (${msg.length} bytes) de ${ws.senderIp} -> ${ws.target || 'rival'}`);
        } else if (opcode === 3) {
          console.log(`[P2P 10555] 🥊 ¡PELEA ACEPTADA! (${msg.length} bytes) de ${ws.senderIp} -> ${ws.target || 'rival'}`);
        } else if (opcode === 4) {
          console.log(`[P2P 10555] ❌ Solicitud cancelada / rechazada (${msg.length} bytes)`);
        }

        // 3. Targeted Routing: Forward strictly to opponent, avoiding self-echos and duplicate sockets
        let deliveredCount = 0;
        for (const peer of peers) {
          if (peer === ws || peer.readyState !== WebSocket.OPEN) continue;

          // Never send back to the same player/tab (avoid echo loops)
          if (ws.senderMac && peer.senderMac && peer.senderMac === ws.senderMac) continue;

          // If this sender socket has a specific target IP, match peer's sender IP or MAC
          if (ws.target && peer.senderIp && peer.senderIp !== ws.target) continue;

          // If the recipient socket is dedicated to a target IP, it must match sender's IP
          if (peer.target && ws.senderIp && peer.target !== ws.senderIp) continue;

          peer.send(msg, { binary: true });
          deliveredCount++;
        }

        // Fallback: If no peer matched strict target routing (e.g. peer connected before params were known),
        // deliver to any peer of a different MAC
        if (deliveredCount === 0) {
          for (const peer of peers) {
            if (peer === ws || peer.readyState !== WebSocket.OPEN) continue;
            if (ws.senderMac && peer.senderMac && peer.senderMac === ws.senderMac) continue;
            peer.send(msg, { binary: true });
            deliveredCount++;
          }
        }
      });

      ws.on('close', () => {
        peers.delete(ws);
        console.log(`[P2P 10555] [-] Peer desconectado (${ws.senderMac || 'anon'}). Restantes: ${peers.size}`);
      });

      ws.on('error', (err) => {
        console.warn(`[P2P 10555] Error: ${err.message}`);
      });
    });

    wss.on('listening', () => {
      console.log(`⚡ [P2P RELAY 10555] Servidor P2P WebSocket activo en puerto ${port}`);
    });
  } catch (err) {
    console.warn(`[P2P 10555] Error al iniciar en puerto ${port}:`, err.message);
  }
  return wss;
}

if (require.main === module) {
  createAdhocServer(null, PORT);
}

module.exports = { createAdhocServer, startP2PRelay };
