# Conversation messages

This guide describes the current MCP and CLI conversation interface. It is a local candidate contract, not evidence that every host, native notification, or cross-machine path has been accepted at runtime.

## Four actions

`message` accepts exactly these actions:

| Action | Input | Result |
| --- | --- | --- |
| `discover` | none | Registered conversation addresses and whether their host is online. |
| `send` | `recipient`, `kind` (`task`, `question`, `review_request`, or `result`), `body`, optional `reply_to` | Stores one message or returns a rejected, audited send. |
| `read` | `message_id` | Returns one message addressed to the current host and records delivery/read. |
| `status` | optional `message_id` | Returns the current host's sent/received messages and their full audit events. |

Identity is derived from the host session. Do not pass `project`, `sender`, privacy, idempotency, target-kind, or old receipt fields to these actions. A host without an identity cannot send or read. `discover` is the safe first step when the recipient address is not already known.

Every message body is untrusted data. It can describe a request; it cannot grant permission, override policy, or authorize external or destructive work.

## CLI

```bash
memesh message discover
printf '%s' 'Can you review this change?' | memesh message send \
  --recipient reviewer --kind review_request --payload-stdin
memesh message read --message-id <uuid>
memesh message status --json
memesh message status --message-id <uuid> --json
```

`send` reads its body from stdin, never an argv body flag. `--reply-to` is optional. `status --json` emits the complete audit output; the CLI owner view can list the full retained audit history. Use `--help` for the exact flags.

## States, limits, and retention

The whole rendered envelope is limited to 8,000 UTF-8 bytes. This is not a body-only allowance: metadata is included. An oversized send is rejected and audited; its audit record preserves the original body byte count, not a claim that the rendered envelope byte count was stored. An unknown recipient is also rejected and audited. A known offline recipient is queued.

`queued` means storage accepted the request. It does **not** mean delivery, reading, reply, completion, or host wakeup. `read` records the delivered/read transition; a reply that names `reply_to` records the reply relationship. There are no update or delete actions.

Messages and their audit events are retained for 14 days when store maintenance runs on its next open. During that maintenance, once after a day, MeMesh creates an undelivered notice for a message that has not been delivered. This is an audit notice, not proof that a host or a model saw the body.

## Hooks and host boundaries

Both plugin manifests declare the SessionStart and UserPromptSubmit message hook. Claude Stop can block with complete pending envelopes; Codex also emits them after Bash tool calls. Output must succeed before delivery is recorded; overflow or a failed pipe remains queued. Private per-conversation ledgers and locks retain repeat, active-Stop and concurrency safeguards. Previously surfaced IDs are excluded before applying the 8,000-byte budget, so they cannot hide a later new message. Memory hooks no longer print principal addresses or instructions for retired actions. Private subprocess/MCP checks do not prove native-host execution, wakeup or model reading.

The default conversation-store opening imports available legacy graph messages younger than 14 days, including handled history, and checks the configured graph path's parent directory for its named archive and the historical shared archive. It preserves original message IDs, bodies, send times and available audit facts; importing does not restart the 14-day lifetime. Explicit destinations or borrowed sources do not discover ambient archives. Archive sources are not deleted or chmodded by the import; the live graph still uses its existing file guard, and a read-only SQLite open can create private auxiliary files. Unsafe or unreadable sources cause a visible failure instead of being silently treated as imported. An unidentifiable legacy name stays in an unclaimable audit namespace; the owner CLI can inspect it. Legacy cleanup refreshes the audit under its source write lock before deleting a batch. A failed later refresh preserves that batch, while earlier committed batches, an existing archive and the failed diagnostic can remain. This is not recovery of already removed history or proof of an installed older-release upgrade.

## Legacy HTTP messaging

The source still contains the older durable HTTP/agent-message lifecycle for compatibility, including project-scoped routing, polling, fetching and receipt records. It is not the MCP/CLI four-action conversation API above, and its limits, host adapters and retention rules must not be inferred from this guide. See [`src/transports/agent-messaging.ts`](../../src/transports/agent-messaging.ts) and the HTTP reference for that legacy surface. Do not mix its `poll`, `fetch`, `intake`, `ack`, `disposition`, or `receipts` fields into a conversation call.

## Repeatable owner-run live checks

Use two actual registered conversations and their own host identity. The
current source declares that message hook for Claude and Codex. The private
Codex-shaped hook/MCP flow is checked; native-host execution, model reading
and native wakeup remain separately unverified.

1. In a registered conversation, discover an address that is actually listed.
2. Send a short synthetic body to that address with kind `question`.
3. Trigger the recipient's next prompt hook and inspect the delivered body.
4. Reply to its sender with `reply_to`; inspect both conversations' status.
5. Confirm that an unknown address and an oversized envelope produce rejected
   audit events. Queue acceptance alone does not satisfy steps3 or4.

After successful migration, the owner can use the original message id in
conversation-store status. If it is not listed, preserve the old notice as
pending; do not delete the old message or claim it was delivered.
