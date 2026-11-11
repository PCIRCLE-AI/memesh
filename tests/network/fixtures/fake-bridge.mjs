// A stand-in for the bridge: it speaks the control protocol on the real socket path.
// FAKE_MODE: running | starting-then-running | starting-then-die | ignore-stop | silent | slow-running
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const mode = process.env.FAKE_MODE ?? 'running';
const dataDir = process.env.MEMESH_DIR;
const network = path.join(dataDir, 'network');
fs.mkdirSync(network, { recursive: true });
let ready = mode === 'running' || mode === 'ignore-stop';
const status = (state) => {
  const now = new Date().toISOString();
  const file = path.join(network, 'bridge-status.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({
    pid: process.pid, started_at: now, updated_at: now, state, relay_state: 'off', last_error: null, last_error_at: null,
    direct_addresses: [], joins_accepted: 0, joins_refused: 0, non_member_refused: 0, frames_received: 0,
  }));
  fs.renameSync(`${file}.tmp`, file);
};
status(ready ? 'running' : 'starting');
const tokenFile = path.join(network, 'control.token');
if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, 'a'.repeat(64), { mode: 0o600 });
const token = fs.readFileSync(tokenFile, 'utf8');
const server = net.createServer((socket) => {
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    if (mode === 'silent') return;
    const request = JSON.parse(chunk.toString());
    if (request.token !== token) {
      socket.destroy();
      return;
    }
    const { op } = request;
    socket.end(`${JSON.stringify({ data_dir: fs.realpathSync(dataDir), pid: process.pid, ready })}\n`);
    if (op === 'stop' && mode !== 'ignore-stop') {
      server.close();
      process.exit(0);
    }
  });
});
fs.rmSync(path.join(network, 'bridge.sock'), { force: true }); // Stale from a killed stand-in.
server.listen(path.join(network, 'bridge.sock'));
setInterval(() => {}, 1000);
if (mode === 'starting-then-running') setTimeout(() => { ready = true; status('running'); }, 1000);
if (mode === 'slow-running') setTimeout(() => { ready = true; status('running'); }, 2500);
if (mode === 'starting-then-die') setTimeout(() => process.exit(1), 1000);
