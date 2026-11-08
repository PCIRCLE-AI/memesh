import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Runs the CLI from `src/` (through Vite, no build), so a test of a CLI command
// goes red when the source changes and does not depend on `dist/` being fresh.
const loader = `
  import { pathToFileURL } from 'node:url';
  const { createServer } = await import(pathToFileURL(process.argv[1] + '/node_modules/vite/dist/node/index.js').href);
  const server = await createServer({ root: process.argv[1], appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  try { const { runCli } = await server.ssrLoadModule('/src/transports/cli/cli.ts'); await runCli([process.argv[0], 'memesh', ...process.argv.slice(2)]); }
  finally { await server.close(); }
`;

export function runCliFromSource(args: string[], options: { cwd: string; memeshDir: string; dbPath: string }) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', loader, path.resolve('.'), ...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: 60000,
    env: {
      PATH: process.env.PATH,
      HOME: options.memeshDir,
      USERPROFILE: options.memeshDir,
      MEMESH_DIR: options.memeshDir,
      MEMESH_DB_PATH: options.dbPath,
      MEMESH_AUTO_CAPTURE: 'false',
    },
  });
}
