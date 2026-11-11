// The local registry's server. A separate process: the installer under test blocks
// its caller's event loop with spawnSync, so a server in the same process would
// never answer. argv: <directory holding wrapper.tgz, platform.tgz and mode> <platform package>
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const [directory, platformPackage] = process.argv.slice(2);
const read = (name) => fs.readFileSync(path.join(directory, name));
const garbage = Buffer.alloc(2048, 0x61);
const server = http.createServer((request, response) => {
  const url = decodeURIComponent(request.url ?? '');
  const isPlatform = url.startsWith(`/${platformPackage}/`);
  const isWrapper = url.startsWith('/@number0/iroh/');
  if (!isPlatform && !isWrapper) {
    response.statusCode = 404;
    response.end();
    return;
  }
  const mode = read('mode').toString();
  if (mode === 'all-garbage' || (mode === 'platform-garbage' && isPlatform)) response.end(garbage);
  else response.end(read(isPlatform ? 'platform.tgz' : 'wrapper.tgz'));
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`${server.address().port}\n`));
