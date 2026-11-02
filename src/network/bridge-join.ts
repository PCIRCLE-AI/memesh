// The joining machine's half of a join, run in a short-lived child so the CLI
// never loads the native file. Input arrives on stdin, not argv: a token in argv
// would be readable by every other process through `ps`.

import { bindEndpoint, deadline, toBytes } from './endpoint.js';
import { loadIdentity } from './identity.js';
import { JOIN_REPLY_MAX_BYTES, encodeJoinRequest, type JoinRequest } from './join-protocol.js';
import { explainLoadFailure, loadNative } from './native-loader.js';
import { JOIN_ALPN, RELAY_OFF, errorMessage, runtimeDir, type NetworkErrorCode } from './types.js';

const RELAY_ONLINE_DEADLINE_MS = 15_000;
// The transport gives up on its own at 30 s and says only "timed out".
const CONNECT_DEADLINE_MS = 35_000;
const REPLY_DEADLINE_MS = 30_000;
const CLOSE_DEADLINE_MS = 5_000;

export const JOIN_CHILD_INPUT_MAX_BYTES = 16 * 1024;

export interface JoinChildInput {
  request: JoinRequest;
  owner_id: string;
  /** Where the owner can be reached. */
  owner_relay: string | null;
  /** Absent when the link names only a relay. */
  owner_addrs: string[] | undefined;
  /** The relay this machine itself uses, or "off". */
  own_relay: string;
}

export type JoinChildResult =
  | { ok: true; reply: string }
  | { ok: false; code: NetworkErrorCode; detail: string };

export async function runJoinClient(dataDir: string, input: JoinChildInput): Promise<JoinChildResult> {
  const identity = loadIdentity(dataDir);
  let iroh;
  try {
    iroh = loadNative(runtimeDir(dataDir));
  } catch (err) {
    return { ok: false, code: 'runtime_load_failed', detail: explainLoadFailure(err) };
  }

  const endpoint = await bindEndpoint(iroh, identity.secret, input.own_relay, []);
  try {
    if (input.own_relay !== RELAY_OFF) {
      // Without a relay the direct addresses in the link may still work, so this is not fatal.
      await deadline(endpoint.online(), RELAY_ONLINE_DEADLINE_MS, 'reaching the relay').catch(() => undefined);
    }
    const target = new iroh.EndpointAddr(iroh.EndpointId.fromString(input.owner_id), input.owner_relay, input.owner_addrs);
    let connection;
    try {
      connection = await deadline(endpoint.connect(target, toBytes(JOIN_ALPN)), CONNECT_DEADLINE_MS, 'connecting');
    } catch (err) {
      return { ok: false, code: 'owner_unreachable', detail: errorMessage(err) };
    }
    const stream = await connection.openBi();
    await stream.send.writeAll(toBytes(encodeJoinRequest(input.request)));
    await stream.send.finish();
    const reply = Buffer.from(await deadline(stream.recv.readToEnd(JOIN_REPLY_MAX_BYTES), REPLY_DEADLINE_MS, 'waiting for the reply'));
    connection.close(0n, toBytes('done'));
    return { ok: true, reply: reply.toString('utf8') };
  } catch (err) {
    return { ok: false, code: 'owner_unreachable', detail: errorMessage(err) };
  } finally {
    await deadline(endpoint.close(), CLOSE_DEADLINE_MS, 'closing the endpoint').catch(() => undefined);
  }
}
