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
const SEND_DEADLINE_MS = 10_000;
const REPLY_DEADLINE_MS = 20_000;
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

/** relay_reached: did this machine reach its own relay? Null when it runs with the relay off. */
export type JoinChildResult =
  | { ok: true; reply: string; relay_reached: boolean | null }
  | { ok: false; code: NetworkErrorCode; detail: string; relay_reached: boolean | null };

export async function runJoinClient(dataDir: string, input: JoinChildInput): Promise<JoinChildResult> {
  const identity = loadIdentity(dataDir);
  let iroh;
  try {
    iroh = loadNative(runtimeDir(dataDir));
  } catch (err) {
    return { ok: false, code: 'runtime_load_failed', detail: explainLoadFailure(err), relay_reached: null };
  }

  const endpoint = await bindEndpoint(iroh, identity.secret, input.own_relay, []);
  let relayReached: boolean | null = null;
  try {
    if (input.own_relay !== RELAY_OFF) {
      relayReached = await deadline(endpoint.online(), RELAY_ONLINE_DEADLINE_MS, 'reaching the relay').then(() => true, () => false);
      // Before the invite is used. A relay chosen with --relay that does not answer
      // would otherwise be saved for good; and with no direct address there is no
      // other way to the owner, so waiting longer cannot help.
      if (!relayReached && (input.own_relay !== input.owner_relay || !input.owner_addrs?.length)) {
        return { ok: false, code: 'relay_unreachable', detail: input.own_relay, relay_reached: false };
      }
    }
    const target = new iroh.EndpointAddr(iroh.EndpointId.fromString(input.owner_id), input.owner_relay, input.owner_addrs);
    let connection;
    try {
      connection = await deadline(endpoint.connect(target, toBytes(JOIN_ALPN)), CONNECT_DEADLINE_MS, 'connecting');
    } catch (err) {
      return { ok: false, code: 'owner_unreachable', detail: errorMessage(err), relay_reached: relayReached };
    }
    // From here the invite may already be spent, and retrying with it is safe either way.
    try {
      const stream = await deadline(connection.openBi(), SEND_DEADLINE_MS, 'opening a stream');
      await deadline(stream.send.writeAll(toBytes(encodeJoinRequest(input.request))), SEND_DEADLINE_MS, 'sending the request');
      await deadline(stream.send.finish(), SEND_DEADLINE_MS, 'sending the request');
      const reply = Buffer.from(await deadline(stream.recv.readToEnd(JOIN_REPLY_MAX_BYTES), REPLY_DEADLINE_MS, 'waiting for the reply'));
      connection.close(0n, toBytes('done'));
      return { ok: true, reply: reply.toString('utf8'), relay_reached: relayReached };
    } catch (err) {
      return { ok: false, code: 'join_interrupted', detail: errorMessage(err), relay_reached: relayReached };
    }
  } finally {
    await deadline(endpoint.close(), CLOSE_DEADLINE_MS, 'closing the endpoint').catch(() => undefined);
  }
}
