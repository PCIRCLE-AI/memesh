// `memesh network ...`: argument parsing and printing only. `link` and `join`
// refuse to run without a terminal, with no override: an invite is something a
// person hands to a person. This slows an agent down rather than stops it: an
// agent could allocate a terminal, so it is not a security boundary.

import { Command, Option } from 'commander';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDbPath, getMemeshDirFromDbPath } from '../core/paths.js';
import { stopBridge } from './bridge-control.js';
import { DEFAULT_INVITE_TTL_HOURS } from './invites.js';
import { bridgeUp, createLink, createNetwork, getNetworkStatus, joinNetwork, type NetworkStatus } from './operations.js';
import { NetworkError, errorMessage, type NetworkContext } from './types.js';

function contextFrom(networkDistDir: URL): NetworkContext {
  const assetsDir = fileURLToPath(networkDistDir);
  return {
    dataDir: path.resolve(getMemeshDirFromDbPath()),
    dbPath: getDbPath(),
    bridgeEntry: path.join(assetsDir, 'bridge.js'),
    assetsDir,
  };
}

export function assertPersonAtTerminal(
  command: 'link' | 'join',
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout,
): void {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new NetworkError('needs_person', `\`memesh network ${command}\` needs a person: run it yourself in a terminal. Agents and scripts cannot run it.`);
  }
}

const progress = (message: string): void => { process.stderr.write(`${message}\n`); };

function action<A extends unknown[]>(run: (...args: A) => void | Promise<void>): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await run(...args);
    } catch (err) {
      // Expected or not, the message never holds the link: nothing here puts it in one.
      process.stderr.write(`Error: ${errorMessage(err)}\n`);
      process.exitCode = 1;
    }
  };
}

function printStatus(status: NetworkStatus): void {
  if (!status.joined) {
    console.log('This machine is not in a network. Single-machine MeMesh does not need one.');
    console.log('To start one: memesh network create --name <machine> --person <you>');
    return;
  }
  console.log(`Network:      ${status.network_id}`);
  console.log(`This machine: ${status.machine_name} (${status.person}), ${status.role}`);
  console.log(`Machine id:   ${status.machine_id}`);
  console.log(`Relay:        ${status.relay}`);
  console.log(`Members:      version ${status.roster_version}`);
  for (const member of status.members) {
    console.log(`  ${member.person}@${member.name}  ${member.machine_id.slice(0, 12)}...  joined ${member.joined_at}`);
  }
  const bridge = status.bridge;
  console.log(bridge.running
    ? `Bridge:       running (pid ${bridge.pid}, since ${bridge.started_at}), relay ${bridge.relay_state}`
    : 'Bridge:       not running. Start it with: memesh network up');
  if (bridge.last_error) console.log(`Last error:   ${bridge.last_error} (${bridge.last_error_at})`);
}

export function registerNetworkCommand(program: Command, networkDistDir: URL): void {
  const network = program
    .command('network')
    .description('Connect this machine to other machines for agent messages. Memory is never shared.');
  const context = (): NetworkContext => contextFrom(networkDistDir);
  const relayOption = new Option('--relay <url>', 'Relay URL, or "off" for direct addresses only');

  network
    .command('create')
    .description('Start a new network on this machine')
    .requiredOption('--name <machine>', 'A name for this machine')
    .requiredOption('--person <me>', 'Your name')
    .addOption(relayOption)
    .action(action((opts: { name: string; person: string; relay?: string }) => {
      const { config } = createNetwork(context(), { ...opts, onProgress: progress });
      console.log(`Created a network with this machine (${config.machine_name}) as its owner.`);
      console.log('Next: memesh network link');
    }));

  network
    .command('link')
    .description('Make a single-use invite link (a person must run this)')
    .option('--ttl-hours <hours>', 'Hours until the link expires', String(DEFAULT_INVITE_TTL_HOURS))
    .option('--include-addresses', "Put this machine's direct addresses in the link (for use without a relay)")
    .action(action(async (opts: { ttlHours: string; includeAddresses?: boolean }) => {
      assertPersonAtTerminal('link');
      const result = await createLink(context(), {
        ttlHours: Number(opts.ttlHours),
        includeAddresses: opts.includeAddresses === true,
      });
      if (result.bridgeStarted) progress(`Started the network bridge (pid ${result.bridgePid}); it answers the link.`);
      console.log(result.link);
      progress(`Single use, expires ${new Date(result.expiresAtMs).toISOString()}. Whoever has it can join: send it privately.`);
    }));

  network
    .command('join <link>')
    .description('Join a network with an invite link (a person must run this)')
    .requiredOption('--name <machine>', 'A name for this machine')
    .requiredOption('--person <me>', 'Your name')
    .addOption(relayOption)
    .action(action(async (link: string, opts: { name: string; person: string; relay?: string }) => {
      assertPersonAtTerminal('join');
      const { roster, member } = await joinNetwork(context(), { ...opts, link, onProgress: progress });
      console.log(`Joined as ${member.person}@${member.name}. The network has ${roster.members.length} machines.`);
      console.log('Next: memesh network up');
    }));

  network
    .command('status')
    .description('Show this machine, the member list and the bridge')
    .option('--json', 'Print JSON')
    .action(action((opts: { json?: boolean }) => {
      const status = getNetworkStatus(context());
      if (opts.json) console.log(JSON.stringify(status, null, 2));
      else printStatus(status);
    }));

  network
    .command('up')
    .description('Start the bridge process')
    .option('--reinstall', 'Reinstall the networking component first')
    .action(action(async (opts: { reinstall?: boolean }) => {
      const { pid, started } = await bridgeUp(context(), { force: opts.reinstall === true, onProgress: progress });
      console.log(started ? `Started the network bridge (pid ${pid}).` : `The network bridge is already running (pid ${pid}).`);
    }));

  network
    .command('down')
    .description('Stop the bridge process')
    .action(action(async () => {
      const { stopped, pid } = await stopBridge(context());
      console.log(stopped ? `Stopped the network bridge (pid ${pid}).` : 'The network bridge is not running.');
    }));
}
