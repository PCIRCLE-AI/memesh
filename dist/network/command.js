import { Option } from 'commander';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDbPath, getMemeshDirFromDbPath } from '../core/paths.js';
import { stopBridge } from './bridge-control.js';
import { DEFAULT_INVITE_TTL_HOURS } from './invites.js';
import { bridgeUp, createLink, createNetwork, getNetworkStatus, joinNetwork } from './operations.js';
import { NetworkError, errorMessage, safeForTerminal } from './types.js';
function contextFrom(networkDistDir) {
    const assetsDir = fileURLToPath(networkDistDir);
    return {
        dataDir: path.resolve(getMemeshDirFromDbPath()),
        dbPath: getDbPath(),
        bridgeEntry: path.join(assetsDir, 'bridge.js'),
        assetsDir,
    };
}
export function assertPersonAtTerminal(command, stdin = process.stdin, stdout = process.stdout) {
    if (!stdin.isTTY || !stdout.isTTY) {
        throw new NetworkError('needs_person', `\`memesh network ${command}\` is meant for a person: run it yourself in a terminal. An invite is something one person hands to another, so this does not run from a pipe or a script.`);
    }
}
const LINK_INPUT_MAX_CHARS = 16 * 1024;
export function promptForLink(stdin = process.stdin, stderr = process.stderr) {
    stderr.write('Paste the invite link (it will not be shown), then press Enter: ');
    return new Promise((resolve, reject) => {
        let text = '';
        const finish = (settle) => {
            stdin.off('data', onData);
            stdin.off('end', onEnd);
            stdin.setRawMode?.(false);
            stdin.pause();
            stderr.write('\n');
            settle();
        };
        const onEnd = () => finish(() => resolve(text.trim()));
        const onData = (chunk) => {
            for (const character of chunk.toString()) {
                if (character === '\u0003' || character === '\u0004') {
                    finish(() => reject(new NetworkError('needs_person', 'Cancelled. Nothing was changed.')));
                    return;
                }
                if (character === '\r' || character === '\n') {
                    if (text.length === 0)
                        continue;
                    finish(() => resolve(text.trim()));
                    return;
                }
                if (character === '\u007f' || character === '\b')
                    text = text.slice(0, -1);
                else if (text.length < LINK_INPUT_MAX_CHARS)
                    text += character;
            }
        };
        stdin.setRawMode?.(true);
        stdin.on('data', onData);
        stdin.on('end', onEnd);
        stdin.resume();
    });
}
const progress = (message) => { process.stderr.write(`${message}\n`); };
export function action(run) {
    return async (...args) => {
        try {
            await run(...args);
        }
        catch (err) {
            process.stderr.write(`Error: ${safeForTerminal(errorMessage(err))}\n`);
            process.exitCode = 1;
        }
    };
}
function printStatus(status) {
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
    if (bridge.unresponsive) {
        console.log(`Bridge:       not answering. ${bridge.pid === null ? 'Its process id is not known.' : `Its last recorded process id is ${bridge.pid}.`} End it with your system's tools if it stays this way.`);
    }
    else {
        console.log(bridge.running
            ? `Bridge:       running (pid ${bridge.pid}, since ${bridge.started_at}), relay ${bridge.relay_state}`
            : 'Bridge:       not running. Start it with: memesh network up');
    }
    if (bridge.last_error)
        console.log(`Last error:   ${safeForTerminal(bridge.last_error)} (${bridge.last_error_at})`);
}
export function registerNetworkCommand(program, networkDistDir) {
    const network = program
        .command('network')
        .description('Connect this machine to other machines for agent messages. Memory is never shared.');
    const context = () => contextFrom(networkDistDir);
    const relayOption = new Option('--relay <url>', 'Relay URL, or "off" for direct addresses only');
    network
        .command('create')
        .description('Start a new network on this machine')
        .requiredOption('--name <machine>', 'A name for this machine')
        .requiredOption('--person <me>', 'Your name')
        .addOption(relayOption)
        .action(action((opts) => {
        const { config } = createNetwork(context(), { ...opts, onProgress: progress });
        console.log(`Created a network with this machine (${config.machine_name}) as its owner.`);
        console.log('Next: memesh network link');
    }));
    network
        .command('link')
        .description('Make a single-use invite link (a person must run this)')
        .option('--ttl-hours <hours>', 'Hours until the link expires', String(DEFAULT_INVITE_TTL_HOURS))
        .option('--include-addresses', "Put this machine's direct addresses in the link (for use without a relay)")
        .action(action(async (opts) => {
        assertPersonAtTerminal('link');
        const result = await createLink(context(), {
            ttlHours: Number(opts.ttlHours),
            includeAddresses: opts.includeAddresses === true,
        });
        if (result.bridgeStarted)
            progress(`Started the network bridge (pid ${result.bridgePid}); it answers the link.`);
        if (result.addressesMissing)
            progress('No direct addresses were found, so this link has none. It works only through the relay.');
        console.log(result.link);
        progress(`Single use, expires ${new Date(result.expiresAtMs).toISOString()}. Whoever has it can join: send it privately.`);
    }));
    network
        .command('join')
        .description('Join a network with an invite link; it asks for the link (a person must run this)')
        .argument('[link]', 'Not accepted here: the link would be visible to other processes. It is asked for instead.')
        .requiredOption('--name <machine>', 'A name for this machine')
        .requiredOption('--person <me>', 'Your name')
        .addOption(relayOption)
        .action(action(async (positional, opts) => {
        if (positional !== undefined) {
            throw new NetworkError('invalid_option', 'Do not put the invite link on the command line, where other processes and your shell history can read it. Run the command without it and paste the link when asked. Nothing was done.');
        }
        assertPersonAtTerminal('join');
        const link = await promptForLink();
        const { roster, member, relayReached } = await joinNetwork(context(), { ...opts, link, onProgress: progress });
        console.log(`Joined as ${member.person}@${member.name}. The network has ${roster.members.length} machines.`);
        if (relayReached === false)
            progress('This machine could not reach its relay; the join went directly. Until the relay answers, it can only be reached directly.');
        console.log('Next: memesh network up');
    }));
    network
        .command('status')
        .description('Show this machine, the member list and the bridge')
        .option('--json', 'Print JSON')
        .action(action(async (opts) => {
        const status = await getNetworkStatus(context());
        if (opts.json)
            console.log(JSON.stringify(status, null, 2));
        else
            printStatus(status);
    }));
    network
        .command('up')
        .description('Start the bridge process')
        .option('--reinstall', 'Reinstall the networking component first')
        .action(action(async (opts) => {
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
//# sourceMappingURL=command.js.map