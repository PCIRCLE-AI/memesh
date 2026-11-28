import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const entry = fileURLToPath(import.meta.url);
const { match, realCli, scenario, pidFile, detached, report, deadline, gcFile } =
  JSON.parse(fs.readFileSync(`${entry}.json`, 'utf8'));
const recordPid = (file) => fs.writeFileSync(file, String(process.pid));
const waitForever = () => new Promise(() => setInterval(() => {}, 1000));
const startHolder = (ms, { detached = false, stdio = ['ignore', 'inherit', 'inherit'] } = {}) => {
  const child = spawn(process.execPath, [entry, '--fixture-hold', String(ms)], { stdio, detached });
  if (detached) child.unref();
};

if (argv[0] === '--fixture-hold') {
  recordPid(gcFile ?? pidFile);
  if (argv[1] === '0') await waitForever();
  else await delay(Number(argv[1]));
} else if (argv[0] === '--fixture-orphan') {
  startHolder(14_000, { detached: true });
} else {
  if (!match.every((word, i) => argv[i] === word)) {
    const result = spawnSync(process.execPath, [realCli, ...argv], { stdio: 'inherit', env: process.env });
    process.exit(result.status ?? 1);
  }
  switch (scenario) {
    case 'send-without-result':
      console.log('{}');
      break;
    case 'grandchild':
      startHolder(0, { detached });
      await delay(200);
      await waitForever();
      break;
    case 'exit-with-grandchild':
      startHolder(0);
      await delay(300);
      console.log('{"stored":false}');
      break;
    case 'report-env': {
      const dir = process.env.MEMESH_DIR;
      const cfg = path.join(dir, 'config.json');
      let config = null;
      try {
        config = JSON.parse(fs.readFileSync(cfg, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      fs.writeFileSync(report, JSON.stringify({
        home: process.env.HOME, dir, auto: process.env.MEMESH_AUTO_CAPTURE, cwd: process.cwd(), config,
      }));
      console.log('{"stored":false}');
      break;
    }
    case 'orphan':
      spawn(process.execPath, [entry, '--fixture-orphan'], { stdio: ['ignore', 'inherit', 'inherit'] });
      await delay(500);
      await waitForever();
      break;
    case 'late-success':
      startHolder(14_000);
      await delay(Math.max(0, deadline - Date.now()));
      console.log('{"stored":true,"name":"x"}');
      break;
    case 'split-output': {
      const bytes = Buffer.from('{"stored":true,"name":"é"}');
      const cut = bytes.indexOf(0xc3) + 1;
      process.stdout.write(bytes.subarray(0, cut));
      await delay(150);
      process.stdout.write(bytes.subarray(cut));
      await delay(100);
      break;
    }
    case 'hang':
      if (pidFile) recordPid(pidFile);
      if (gcFile) startHolder(0, { stdio: 'ignore' });
      await waitForever();
      break;
    default:
      throw new Error(`Unknown fixture scenario: ${scenario}`);
  }
  process.exit(0);
}
