// A stand-in for the bridge with the right command line: node .../bridge.js serve <dir>.
import fs from 'node:fs';
import path from 'node:path';

const mode = process.env.FAKE_MODE ?? 'running';
const dataDir = process.argv[3];
const network = path.join(dataDir, 'network');
fs.mkdirSync(network, { recursive: true });
fs.writeFileSync(path.join(network, 'bridge.pid'), `${process.pid}\n`);
const status = (state) => {
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(network, 'bridge-status.json'), JSON.stringify({
    pid: process.pid, started_at: now, updated_at: now, state, relay_state: 'off', last_error: null, last_error_at: null,
    direct_addresses: [], joins_accepted: 0, joins_refused: 0, non_member_refused: 0, member_stub_served: 0,
  }));
};
setInterval(() => {}, 1000);
if (mode === 'running') status('running');
if (mode === 'starting-then-running') { status('starting'); setTimeout(() => status('running'), 1000); }
if (mode === 'starting-then-die') { status('starting'); setTimeout(() => process.exit(1), 1000); }
if (mode === 'term-no-cleanup') { status('running'); process.on('SIGTERM', () => process.exit(0)); }
if (mode === 'ignore-term') { status('running'); process.on('SIGTERM', () => {}); }
