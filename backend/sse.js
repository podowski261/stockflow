// ══════════════════════════════════════════════════════
//  SSE MANAGER — Server-Sent Events pour temps réel
// ══════════════════════════════════════════════════════

const clients = new Set();

function addClient(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  clients.add(res);

  // Keepalive ping toutes les 25s
  const ping = setInterval(() => {
    res.write('event: ping\ndata: {}\n\n');
  }, 25000);

  res.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

function broadcast(eventType, data) {
  const msg = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => {
    try { res.write(msg); } catch (_) { clients.delete(res); }
  });
}

module.exports = { addClient, broadcast };
