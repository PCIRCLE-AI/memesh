// A local stand-in for the npm registry, so install tests do not depend on the real
// one and can serve exactly the bytes they want: real tarballs built from small
// fixtures, or garbage, per package.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { npmSync } from '../../scripts/lib/npm-bin.mjs';
import { removeTree } from './helpers.js';

const lockText = fs.readFileSync(path.resolve(import.meta.dirname, '../../src/network/runtime-lock.json'), 'utf8');

export interface Registry {
  url: string;
  /** Which bytes to serve from now on. */
  serve(mode: 'good' | 'platform-garbage' | 'all-garbage'): void;
  /** The shipped lock, with the chosen packages' checksums changed to match the fixtures. */
  lockWith(match: { wrapper: boolean; platform: boolean }): string;
  close(): void;
}

function pack(directory: string): Buffer {
  const output = npmSync(['pack', '--silent', '--ignore-scripts'], { cwd: directory, encoding: 'utf8' }) as string;
  return fs.readFileSync(path.join(directory, output.trim().split('\n').pop() as string));
}

const integrityOf = (tarball: Buffer): string => `sha512-${createHash('sha512').update(tarball).digest('base64')}`;

export async function startRegistry(platformPackage: string): Promise<Registry> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-network-registry-'));
  const wrapperDir = path.join(work, 'wrapper');
  const platformDir = path.join(work, 'platform');
  fs.mkdirSync(wrapperDir);
  fs.mkdirSync(platformDir);
  fs.writeFileSync(path.join(wrapperDir, 'package.json'), JSON.stringify({
    name: '@number0/iroh',
    version: '1.2.0',
    main: 'index.js',
    // Must never run: --ignore-scripts.
    scripts: { postinstall: 'node -e "require(\'fs\').writeFileSync(process.env.HOME + \'/POSTINSTALL-RAN\', \'x\')"' },
  }));
  fs.writeFileSync(path.join(wrapperDir, 'index.js'), `module.exports = require(${JSON.stringify(platformPackage)});`);
  fs.writeFileSync(path.join(platformDir, 'package.json'), JSON.stringify({ name: platformPackage, version: '1.2.0', main: 'index.js' }));
  fs.writeFileSync(path.join(platformDir, 'index.js'), 'module.exports = { Endpoint: { builder() { return {}; } } };');
  const wrapper = pack(wrapperDir);
  const platform = pack(platformDir);
  fs.writeFileSync(path.join(work, 'wrapper.tgz'), wrapper);
  fs.writeFileSync(path.join(work, 'platform.tgz'), platform);
  fs.writeFileSync(path.join(work, 'mode'), 'good');

  const server = spawn(process.execPath, [path.resolve(import.meta.dirname, 'fixtures/registry-server.mjs'), work, platformPackage], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<string>((resolve, reject) => {
    server.stdout.setEncoding('utf8').once('data', (chunk: string) => resolve(chunk.trim()));
    server.once('exit', (code) => reject(new Error(`the registry server exited with ${code}`)));
  });

  return {
    url: `http://127.0.0.1:${port}/`,
    serve(mode) { fs.writeFileSync(path.join(work, 'mode'), mode); },
    lockWith(match) {
      const lock = JSON.parse(lockText) as { packages: Record<string, { integrity?: string; hasInstallScript?: boolean }> };
      if (match.wrapper) {
        lock.packages['node_modules/@number0/iroh'].integrity = integrityOf(wrapper);
        lock.packages['node_modules/@number0/iroh'].hasInstallScript = true;
      }
      if (match.platform) lock.packages[`node_modules/${platformPackage}`].integrity = integrityOf(platform);
      return JSON.stringify(lock);
    },
    close() {
      server.kill('SIGKILL');
      removeTree(work);
    },
  };
}
