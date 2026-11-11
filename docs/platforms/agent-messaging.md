# Local Agent Messaging Guide

MeMesh provides two complementary collaboration surfaces on one machine:

- shared durable memory, including the `team` namespace, for knowledge, decisions, and coarse handoffs;
- the `message` tool for explicit durable messages to one named recipient on the same MeMesh instance.
- `message discover` for a bounded, project-scoped view of currently live host registrations.

Use `memesh message discover --project <name> [--limit 1..100]` to read the
router directory. Results expose `session_id`, `principal_id`, `host_kind`,
`project`, `model` (always `null`: no host tells MeMesh which model a session
runs, so none is shown; the key stays for older clients), live or configured
`work_summary` (`null` when absent), `active`, `generation`, and
`lease_expires_at_ms`. Discovery performs no send, fetch, ACK, replay, or
receipt operation; router unavailability is an explicit error, never an empty
directory. From the CLI you do not start the router first: `memesh message
discover` (and a `message send` to an exact session) starts the installed
`memesh-router` when nothing is listening, waits for it, then continues; if it
cannot start, the command prints one sentence saying so, naming `memesh-router`,
and exits 1. The router it starts keeps running after the command ends. MCP and
HTTP calls do not start it.

Supported Claude and Codex hosts provide an activity summary when available: repository and branch, title, and an in-progress task; Claude may also report busy or idle. Missing information is omitted. The router refreshes this at heartbeat (normally up to about 30 seconds); an older router receives no new heartbeat field. Codex plan activity requires its native `update_plan` tool and the plugin's PostToolUse hook; enabling that tool is an owner choice.

Ordinary Claude Code MCP sessions register automatically after initialization,
using the host's real session id, bound workspace and existing inbox identity.
No Channel setup is needed to appear online. Registration follows the MCP
process lifetime and its existing router lease. Missing session/workspace is reported on stderr; an invalid identity stays
unregistered. Neither disables memory tools.
Online presence alone does not prove live push. When the native Claude inbox socket is available, an ordinary session receives a bounded notice and fetches the body. Without it, the durable inbox and normal hook reminders remain available. A Channel for the same session takes precedence without a duplicate
online entry. Windows remains outside the secure local-router runtime.

Briefing follows the same trust boundary. Generic `briefing` has no recipient
identity, so it never aggregates or announces unread message activity.
Claude Code's installed hooks use recipient `claude-code` by default, or
the configured identity described below. To choose an explicit identity,
start with `MEMESH_RECIPIENT=<exact recipient id>` (for example
`MEMESH_RECIPIENT=claude-implementer claude`). The hooks say, at session
start and at every prompt, how many messages are waiting for exactly that
recipient and in which project to poll (senders choose the project string, so
each project with a waiting message is named, up to five, most waiting first),
until the session records the `intake` action for them (fetching alone does not
end it). Basic reminders need no Channel registration or launch flag;
they do not wake an idle or stopped session. An explicitly empty
`MEMESH_RECIPIENT` disables these reminders. A value over 200 characters, or shaped like
a filesystem path (the same rule the `message` tool refuses a recipient by —
`/root`, `C:\work`, `\\host\share`), is refused rather than silently accepted,
with no database required: one line on stderr (`MEMESH_RECIPIENT ignored: ...`),
one `notified` record in `hook-outcomes.jsonl`, and — since a hook that exits 0
never shows its stderr to the user or the model — the same rejection text in
SessionStart's own visible output, every session start.

The lookup behind that reminder is not limited to messages addressed to the
recipient string itself (#490). A message sent with `target_kind: "session"`
is addressed to the HOST's own `session_instance_id`, not to `MEMESH_RECIPIENT`
or its owner-private fallback — a different string an ordinary reminder would
never match. SessionStart, the prompt hook and the Stop gate below all also
find a delivery like that when the target session is registered, in the
delivery's own project, under the resolved recipient as ITS principal, AND is
LIVE right now (a connection with no disconnect and an unexpired lease). A
session that has since disconnected or let its lease expire is not
surfaced — this never nags about a dead session. The reminder line for a
match like this names the target session as the recipient to use, not the
principal: `... waiting for the live session "<session id>" ... fetch each
message_id with target_kind "session" (fetch or intake using your own
principal id instead of "<session id>" will not match this session-targeted
message) ...`. `intake`, a `disposition`, an `ack` or an `activation` for such
a delivery from a caller that is itself another registered session of the
project (`CLAUDE_CODE_SESSION_ID` / `CODEX_THREAD_ID`) is refused with
`intended_for_other_session` (#497). A caller with no session id, or with an
id no session registered, still can — a Codex MCP process has none. The
reminder and the Stop gate follow the same line (#566): a hook that knows its
session id counts a session-targeted delivery only when it is addressed to
that session (or to an id it had before `/clear`), so another live session of
the same principal is neither reminded of it nor blocked on it. Under
Codex, SessionStart and the prompt hook do not remind about a delivery the
router already pushed into THIS thread with its body (its host acceptance
names this thread and is not a `content: "notice"` acceptance — see below)
while the MeMesh host connection that accepted it is still live; a delivery
pushed into a different thread of the same principal, or accepted by a host
connection that has since ended — for example an acceptance recorded by an
older release, before the queue carried only notices, whose `codex exec` run
exited before running it — is still reminded until the recipient records
intake (#514). Under Claude Code they still remind.

Discover cards include a handle made from the project name before `~`, the host kind, and the last four session ID characters. Send with `recipient_handle` (CLI: `--recipient-handle`) instead of `recipient` to resolve a registered session, including an offline one. Claude and Codex CLI sessions resolve to their principal with `intended_session`; other hosts resolve to the exact session. A missing or ambiguous handle is rejected before writing; use an available handle or an exact session ID. Handles identify host kinds, not models.

The Codex plugin checks for newly waiting messages after a Bash tool call and adds a count and fetch guidance once per message per session. A notice-only host acceptance does not suppress this reminder; recording intake ends the unread state. The reminder does not include message content or sender.

Every Claude Code session in one project shares one principal, so a message
sent to that principal reaches all of them. A message can instead name the
one session it is meant for (#497): `send` with `target_kind: "principal"` and
`intended_session: "<session id>"`. The session id is the one the host's
hooks receive as `session_id`: for Claude Code, `CLAUDE_CODE_SESSION_ID` (set
in the MCP servers and shell commands it starts); for an ordinary Codex CLI
thread, its thread id, which Codex sets as `CODEX_THREAD_ID` only for
commands it runs in its shell — not for MCP servers. A session registered
through any other host (`acp`, or `codex-app-server`, which registers a
configured id rather than the thread id) is refused, because nothing there
could say which session it is when it records intake. An id the router never
registered is also allowed. Ordinary Claude MCP presence uses `claude-inbox`,
which can identify the same session for intake without Channel. A `target_kind: "session"` send with
`fallback_to_principal: true` does this by itself when the session refuses the
message (`recipient_unavailable`): it sends the same message to the principal
that session registered under, with `intended_session` set to it, and returns
that message with a `fallback` field naming the refused one.
`fallback.intended_session_connected` says whether that session is connected
now; when it is not, `fallback.note` says that only it can take the message in
when it next runs, so a sender whose target has ended for good knows to send to
the principal without `intended_session` (#518). A session the
router never registered has no known principal, so that send still fails,
saying so, and so does a refused session registered through a host that
cannot be named.
An unreachable router (`router_unreachable`) does not trigger the
fallback. The refused session delivery is kept, so if that session comes back
it can see the message twice — its own session copy and the principal copy —
and should record intake for both. Retrying the same call (the same
`idempotency_key`) returns the principal message made by the first one, even
when the session has come back since or the retry leaves out
`fallback_to_principal`; it does not deliver again. For a message like this:

- only that session's hooks (SessionStart, the prompt hook, the Stop gate)
  count it as waiting, and so does `briefing` where it knows the session: the
  MCP tool under Claude Code, or the CLI run from a Codex shell. Every other
  session of the principal does not, and neither does a caller with no
  session id;
- only that session can record `intake` or a `disposition` for it, and a
  caller that names another session is refused an `ack` or an `activation`
  too. The MCP tool and the CLI take the caller's session from
  `CLAUDE_CODE_SESSION_ID`, else `CODEX_THREAD_ID`. Any other caller for
  `intake` or a `disposition` — another session, or HTTP and the HTTP clients,
  which have no session — gets an error that starts `intended_for_other_session`
  (over HTTP it is a 400 whose `errorCode` is the generic `operation.failed`; the
  code is in the `error` text), and the message
  stays waiting for the session it is meant for; an `ack` or an `activation`
  from a caller with no session id (HTTP, the router itself) is not refused. A
  Codex session records it with the CLI from its shell
  (`memesh message intake ...`), because Codex does not pass its thread id to
  MCP servers. `poll`, `fetch` and `receipts` are not restricted for the
  principal's other sessions;
- the router pushes it only to that session's connection. With that session
  not connected it stays durable, for the hooks to surface.

After `/clear`, Claude Code gives the session a new id for its hooks and
Bash, while the memesh MCP server and the channel host keep the one they
started with. On macOS and Linux, memesh links the two through the `claude`
process both run under (its pid and start time, recorded at every
SessionStart), so a message meant for the session reaches it, and can be
intaken, under either id. On Windows (no `ps`) the ids are not linked, and
neither are they when the session could not be recorded (the database was
busy at SessionStart, for example); that failure is recorded in
`hook-outcomes.jsonl`.

A message with no `intended_session` (every message sent before this
existed, too) keeps reaching every session of the principal. The Claude
channel host registers with the router under `CLAUDE_CODE_SESSION_ID` when its
config names no `session_instance_id`, so the router's session id, the hooks'
`session_id` and `intended_session` are the same string.

If the declared recipient's inbox is empty everywhere, that reads exactly like
a typo'd id — so SessionStart (only; not every prompt), once a database with
the messaging tables exists, additionally checks whether the id has ever been
addressed in ANY project at all, and if not, adds one hint line:
`MEMESH_RECIPIENT "<id>" has never been seen in any project —
check it for a typo (or ignore this if it is a genuinely new recipient id)`.
It is worded as a hint, not a fact — a legitimately new recipient id answers
the same "never seen" question a typo does, and this cannot tell them apart.
An id that was once seen but has gone quiet since gets no hint either: telling
them apart would mean revealing that some OTHER recipient is still getting
mail, which this hint must never do.
If the inbox cannot be read (its receipts table will not
load, for example), the prompt or session start goes ahead without the
reminder, says so on stderr, and records an `error` in `hook-outcomes.jsonl`
(`inbox: uncaught <code>`), so a run that could not look is not mistaken for
one where nothing was waiting. A caller that already knows its exact
logical recipient may pass both `project` and `recipient` to `briefing`; the
result reports only that recipient's unfetched deliveries and tells it to
`message poll` with the exact scope before fetching each returned
`message_id`. Fetching remains separate from intake and acknowledgement.

The messaging path keeps durable store-and-forward compatibility. Claude Channel receives the bounded full envelope. Ordinary Claude inbox and Codex CLI receive a short notice naming the message; the agent fetches the body from the inbox. An exact Claude inbox send is accepted only when a matching newly appended native receive record is observed; lack of confirmation does not prove the notice was not delivered. An oversized full envelope
returns `native_message_too_large`; other unavailable or rejected exact sessions
return `recipient_unavailable` while the message stays in the inbox until its one day is up.
Principal targets retain asynchronous store-and-forward semantics.
The JSON-encoded durable payload is limited to 65,536 UTF-8 bytes (64 KiB).
Native delivery separately limits the complete envelope, including routing
metadata and payload, to 16,384 bytes (16 KiB). Fitting the durable limit does
not guarantee that a native envelope fits; exact-session messages should stay
comfortably below the native cap.
The size failure is permanent for that exact envelope and is reported as
`native_message_too_large`, so callers do not retry it as transient session
unavailability.
`poll`/`watch` are compatibility and diagnostic APIs. A queue admission or
`host_accept` is not proof that an agent read the payload, acknowledged it, or
accepted the work. What `host_accept` means depends on the host. For the Claude Code inbox it is
recorded only after the notice is seen in the session's conversation. For the
Claude Code Channel it means the notice was handed over and queued, and for
Codex that it was queued for the thread; MeMesh does not see either one shown.
Claude Code holds a peer message
back for its user in several cases, for example when the sender does not state
its permission mode and the session bypasses permission prompts, when the two
sessions' permission modes differ, or when a `crossSessionInbound` setting says
to hold; MeMesh does not state a mode on anyone's behalf.
The attempt is then recorded as `notice_held` (Claude Code wrote its "Held peer message" line; it waits for
its user to approve or deny, which MeMesh cannot see, and within the same MCP process the same notice is not sent
again; it is read on from where it stopped, so a notice approved later is taken as delivered the next time the host is handed it; if the conversation record cannot be read on from where the hold stopped (it grew by more than 1 MiB between two hand-overs, was replaced, shrank or changed owner) the notice is sent once more, and this process never sends it a third time: a notice sent again that is then neither confirmed nor held stays unconfirmed, and a hold that cannot be followed a second time, or that this process forgot to stay within its limit of 500 holds, stays held; Claude Code's hold line shows only the start of a notice, so a notice that merely arrives late while another is held is reported as held until the next hand-over, and one that Claude Code dropped stays reported as held until the MCP server restarts, the message waiting in the inbox meanwhile) or `notice_not_confirmed`, there is no `host_accept`, and `memesh doctor`
reports it. If MeMesh cannot read the session's conversation record at all, the attempt is
recorded as `transcript_unavailable` or `transcript_not_found` instead, and `memesh doctor` reports that in a row of its own (it counts a message under its latest attempt only). The message stays in the inbox
and is raised at that session's next prompt or turn end. To receive the live
notice, set `crossSessionInbound` to `accept` in that Claude Code session or
install the MeMesh Channel. `status` shows this as `queued` with the failure
code. A notice Claude Code is holding for a message the agent never answers is
sent again when the MCP server starts afresh (a new session or a restart), because
the record of the hold lives only in the process that saw it. An agent only
needs to record `intake`; `ack` and `disposition` are optional, but `memesh message
storage prune --apply`, which the owner runs, removes a payload only once a
terminal disposition (`completed`, `cancelled` or `rejected`) is recorded, so
record one when the work is done.
A delivery attempt that the router stopped waiting for (`host_outcome_timeout`)
does not mean the host did not run it: a host that finishes later still sends
its acceptance, and the router records it for exactly that attempt on that
same, still-current connection, so the delivery is not sent again. The
timed-out attempt stays recorded in the database, and a sender that was told
the send failed was told so for that attempt. A host that stops before
sending its acceptance can still be sent the same delivery again: delivery is
at least once, not exactly once.

## Claude Code recipient fallback, Stop gate, and channel-flag warning (#468)

Three Claude-Code-only pieces close the gap where a live channel misconfiguration
left a session with no way to learn a message was waiting at all.

**Recipient fallback.** When `MEMESH_RECIPIENT` is unset (not merely empty) and
this hook run is Claude Code, SessionStart and the prompt hook read
`principal_id` — never `token_file` (the router token's path), and never `project` (below) — from the
owner-private `hosts/claude.json` the [Claude channel runner](#claude-channel-runner)
setup below writes, and use it as the recipient whenever the file is present
and valid. If that file is absent, they use the local `claude-code` principal;
no config or router token is created. Existing unreadable or insecure files,
or an invalid `principal_id`, remain quiet rather than choosing a different
identity. This makes basic reminders independent of the optional Channel.
Both paths use the same message IDs and intake receipts: a Channel acceptance
alone does not stop reminders, while recorded intake does. Codex
runs the same hook scripts (its own copy of the hook list in `.codex-plugin/plugin.json`, with the same Stop and SessionStart entries) and never uses this fallback: it has its own
automatic thread-scoped registration and would otherwise silently adopt
Claude's principal in a shared project.

`hosts/claude.json` may carry a `project` field — from an older setup, or from
`memesh agent setup claude --project`, which still records one for reference
(#474 changed what the Claude channel host itself does with one — see the
setup section below); this fallback ignores it, the same as the channel host
does. `principal_id` is one stable identity for every Claude Code session on
this machine, in every project — a reminder or a Stop-hook block for that
principal can be about a message sent from a different project than the one
the current session is in; `message discover --project <name>` and the
reminder's own project line tell you which.

**Stop gate.** A separate Claude Code Stop hook, registered after
`session-summary.js`, resolves the recipient the same way (declared or
fallback) and blocks the stop — `{"decision":"block","reason":"..."}`, printing
the same waiting-message text the prompt hook shows (including a
live-session-targeted match, #490 above) followed by one instruction sentence,
`Poll, fetch and record intake for each before you stop.` — once per
(project, message id) pair that has no intake receipt yet and that this session
has not already been blocked for. Whether a `host_accept` row exists is irrelevant to
this: `host_accept` is not proof of delivery (see above), so a message a
stopped or disconnected exact session never actually received still blocks the
stop just as readily as one that was pushed. Under Codex the hook still starts, but it records a skip (`this Stop is not running under Claude Code`) and never blocks.

The per-session record of which ids it has already blocked for lives beside
the database, keyed by `session_id`, next to the existing Stop-side
per-session state files, and is the ONLY thing that stops a re-block (#492).
`stop_hook_active: true` on the Stop payload means "a Stop hook blocked the
prior turn" — it does not say this gate was the one that blocked it, so the
gate does not skip on that flag alone: a message that arrives while a
DIFFERENT Stop hook (a project's own verify-receipt gate, say) is holding the
block chain open still reaches the blocked-id ledger and, finding its id new,
blocks once — the same as any other new id, active flag or not. What the
ledger does prevent is re-blocking for an id it already blocked for in this
session, `stop_hook_active` or not. The gate writes the ledger before it
blocks; if the write fails (a full disk, a read-only directory) it records an
`error` outcome and, on a Stop that is already continuing a block, does not
block, so an unwritable ledger cannot keep the session from stopping.

**Channel-flag warning.** SessionStart also checks, only when
`hosts/claude.json` exists (the channel is configured) and only under Claude
Code, whether the launching `claude` process's own command line shows a
MISTYPED attempt at the channel flag — walking a few levels up the process
ancestry with `ps -o ppid=,command=` to find it. Deliberately narrow: most
Claude Code sessions never opt into channels at all, including on a machine
whose `hosts/claude.json` is left over from a past setup, so warning on every
flag-less session would be noise for exactly that owner. It warns only when
the line shows an INTENT to load the channel that the exact flag does not back
up — the flag word `dangerously-load-development-channels` present but not as
the exact double-hyphenated token (a dash silently autocorrected into an em
dash, `—dangerously-load-development-channels`, is the observed real-world
case), or `server:memesh-channel` present with no exact flag token anywhere on
the line. A command line mentioning neither stays silent. Either mistyped
shape leaves the channel MCP server running while every notification is
dropped, with no other symptom; this is the one line of feedback for that
failure mode. If the launching process cannot be identified at all, this says
nothing — a false warning is worse than a missed one.

## One-time owner-private local-host setup

**Two tiers, easy to conflate.** `memesh agent setup <host>` (below) only writes local files — the host config, plus the router token if it does not exist yet — and registers nothing by itself, and for `claude`
and the managed `codex` runner it must be followed by actually starting that
host (`memesh-host-claude` via [Claude channel runner](#claude-channel-runner),
`memesh-host-codex` via
[Separate: MeMesh-managed Codex app-server runner](#separate-memesh-managed-codex-app-server-runner)).
The [Claude channel runner](#claude-channel-runner) tier additionally requires
Claude's own `--dangerously-load-development-channels` opt-in, since Claude
Channels is an upstream research-preview feature — that step is NOT required
for ordinary Codex plugin sessions (which auto-register per thread with no
setup at all) or for durable, non-live `send`/`fetch` to a stable recipient
(which needs no registration of any kind). If discovery/live delivery isn't
working, first confirm which tier you actually need before debugging the
wrong one.

Native delivery is optional and local to one Unix account. Do this setup once
for the account that owns both the MeMesh database and the active host
sessions; do not place router tokens or host config in a repository, shared
dotfile, or world-readable temp directory.

Each configured host connection attempts to start the packaged router and
retries when its owner-private socket is absent or refused. You can also start
the router yourself when you want to inspect it directly; it creates an
owner-private token and socket beside the active MeMesh database on first
start:

```bash
umask 077
memesh-router
```

The router ends itself when no host has been connected, and no delivery has
been running, for 10 minutes: it writes the time to the database (`memesh doctor`
shows it as the last idle exit), exits with status 0 and removes its socket (the
startup lock is already released once it is listening). Nothing is lost, because
messages are stored in the database and the next host connection starts a new
router, which delivers the principal messages that are waiting. A sender that is
not a host (HTTP, the CLI) starts the router the same way when it finds none, so
`send` with `fallback_to_principal` and `discover` keep working. Set
`MEMESH_ROUTER_IDLE_MS` (whole milliseconds) to change the time, or to `0` to keep
the router running until it is stopped; `MEMESH_ROUTER_IDLE_CHECK_MS` (at least 50)
sets how often it looks, 30 seconds by default. A missing router socket is
therefore normal when no session is open. A router you start yourself with
`memesh-router` ends the same way unless `MEMESH_ROUTER_IDLE_MS=0`.

The socket path — `MEMESH_ROUTER_SOCKET` if set, otherwise derived from your
MeMesh database location — must fit in the 103-byte limit a Unix domain
socket allows. A long `HOME` or `MEMESH_DIR` can push the default path over
that limit; `memesh-router` then refuses to start and prints the path and its byte count; `MEMESH_DOCTOR_PROBE_MESSAGE_ROUTER=1 memesh doctor` reports the same as a FAIL (plain `memesh doctor` leaves that row as an opt-in INFO). Move `HOME`/`MEMESH_DIR` somewhere shorter to fix it. `MEMESH_ROUTER_SOCKET` changes only the path that `memesh-router`, `memesh doctor`, senders and ordinary Claude MCP sessions use. It does not reach ordinary Codex plugin sessions: they use the default path, and there is no config of theirs to edit unless you create `hosts/codex-session.json` with `memesh agent setup codex-session` — which also replaces their principal, and which writes the default path as its `router_socket`, so that file would need the override too. Configs written by `memesh agent setup` for the managed hosts keep the default path in `router_socket` and need the same edit. The folder that holds the socket must be owner-private; with `MEMESH_DB_PATH` set, the default socket sits in that database's folder.

If you start it yourself and want it to stay, set `MEMESH_ROUTER_IDLE_MS=0` and leave that process running. In a second terminal,
verify only the installed adapter imports and the live router socket separately:

```bash
MEMESH_DOCTOR_PROBE_MESSAGE_CAPABILITY=1 memesh doctor
MEMESH_DOCTOR_PROBE_MESSAGE_ROUTER=1 memesh doctor
```

The first command proves the installed MCP schema and adapter imports. The
second only proves that the owner-private router socket accepts a connection.
Neither command starts or registers a host, sends a message, proves
`host_accept`, or wakes a stopped session.
In particular, a socket check does not start the host it observes.

The secure host-native router and adapter runtime currently supports macOS and
Linux. Windows remains supported for core MeMesh memory, durable message
storage, and MCP tools, but host-native wakeup fails closed before creating
credentials, configuration, IPC listeners, or managed child processes.

The default local endpoint is versioned with the wire protocol
(`agent-router-v2.sock`). This lets a current router start beside an incompatible
legacy daemon after an upgrade instead of killing it or taking over its live
socket. Existing generated configs that name the former default are normalized
in memory; an explicit custom socket remains exact and reports
`router_version_mismatch` when it exposes the known legacy response shape.

Within one protocol version, the router also reports the MeMesh version it
runs, and each host sends its own when it registers. A router that
started before an upgrade is caught this way instead of silently routing with
the old code:

- A router older than the host, from a release that reports its version,
  refuses that registration with `router_outdated`, stops, and does not start
  again for ten minutes as that older version. The host retries and starts the
  installed router.
- A router from before versions were reported cannot stop itself. The host
  refuses it with `router_outdated` and the instruction to stop it
  (`pkill -f dist/host-runtime/router.js`); the next MeMesh session starts the
  installed one.
- A router newer than the host is used as is.

Create one reusable owner-private config for each managed local host and
principal. The stable principal is the logical recipient. The managed Codex runner generates a fresh exact session identity per process; the Claude channel host registers under the Claude Code session it runs in (`CLAUDE_CODE_SESSION_ID`) and generates one only outside Claude Code. Ordinary Codex plugin sessions instead
register automatically from the Codex thread identity supplied at SessionStart,
using a distinct thread-scoped principal; no thread ID is copied by hand.

```bash
memesh agent setup codex --principal codex-reviewer --workspace "$PWD"
memesh agent setup claude --principal claude-reviewer
```

No `--project` is needed, or read, for routing (#474). Each host derives its
own routing project the same way `message discover`'s automatic project
already does: `claude` from its own process's working directory (the
directory Claude Code was started in), `codex`/`codex-session`/`gemini` from
their `--workspace`. Two hosts started in the same directory — a Claude
session and a Codex thread in one repository, say — therefore land in the
same project automatically; nothing has to be typed or copied between them.
`--project` is still accepted, for a script written before this changed, and
a given value is still written into the config file, but no host reads it
back to decide where it registers.

An optional declaration can be persisted with `--work-summary <text>` (capped
at 200 characters); no default is guessed. `--model <id>` is accepted only so an
older script does not fail: it prints that it is ignored and writes nothing,
because the model is the host's choice per session and MeMesh cannot see it.
For ordinary Codex only, `memesh agent setup codex-session ...` is an optional
workspace-specific stable-principal override, not an activation prerequisite.

### Ordinary active Codex CLI session

An ordinary local Codex session requires the MeMesh Codex plugin to be installed
and enabled so Codex loads the packaged SessionStart hook. Each startup or
resumed thread then registers automatically under the current project with a
thread-scoped principal. Use `message discover` to obtain the exact live session
ID. No manual `agent setup` is required.

The automatic project is a readable repo label plus a 32-hex identity suffix.
For a network Git remote, the suffix covers a password-free locator; otherwise
it covers the native real path. Standard GitHub HTTPS and SSH spellings
converge. Generic SSH locators keep the login and whether the repository path is
absolute or relative to that login's home, preventing distinct accounts or
paths from sharing one scope. This keeps the same repo together across
subdirectories, symlinks, remote-backed clones, and linked worktrees without
letting two unrelated repos named `shared` discover or receive each other's
messages. `memesh briefing --json` in that workspace reports the exact project value.

If one workspace needs a stable named principal across different threads, run
`memesh agent setup codex-session --principal codex-reviewer --workspace "$PWD"`
there and restart Codex. The owner-private config overrides the principal only
when its exact real workspace matches; the project is always the automatic one
above, the same as an ordinary thread there would get (#474 — an older config
that still names a `--project` is ignored, not honoured). Another workspace
still uses automatic identity; a malformed or insecure override fails closed
rather than silently downgrading.

This guide's supported documented path is ordinary Codex CLI `SessionStart`.
Codex Desktop or an unattached task is not user-visible native-delivery
evidence unless that exact live session registers with the router and the
result is directly verified. This is a scope boundary for evidence, not a
claim that Codex Desktop is universally unsupported.

On `SessionStart` for `startup` or `resume`, a short hook validates the Codex
thread identity and cwd, then launches an owner-private detached companion.
Detachment is required because Codex reaps an async hook child when the CLI
process exits, while `codex queue` accepts the thread only after its active
writer is gone. `SessionEnd` leaves a bounded 45-second idle queue window;
resume replaces the prior exact generation through its private control socket,
also when the same thread is resumed from another directory (it then registers
under that directory's project; a `SessionEnd` from the old directory does not
end the new registration), and expiry removes the registration. A missing or malformed identity, invalid
cwd, insecure explicit override, or failed connection does not register a host.
A companion records its control socket, with the socket's inode, as soon as it
binds it, and marks the record registered once the router accepts it. The
socket is removed only by that companion while the path is still its own, or
after its record shows its process is gone and the socket is still the one it
bound. A start while another start for the same session is still under way,
or with a socket in the way that no record accounts for, is refused with one
`companion_busy` line, and the file is left alone: nothing can prove such a
socket unused. A record left by a MeMesh from before #518 does not block a start once its process has exited (its socket used another name and is left in place); if that process is still running but does not answer, the start is refused with `companion_busy`, naming the process to check and the record to delete.
The companion has no terminal of its own, so a reason it could not stop
cleanly is appended to the owner-private `codex-companion.log` in the MeMesh
data directory, and so is what a start or `SessionEnd` did with the record of
a companion that had exited (its socket removed, or left in place and why).
When a start fails, the reason is printed after `session registration failed.`; when the failure happened inside the companion, it is also recorded in that log.

For a registered session, MeMesh invokes `codex queue` with a short notice, never
the message body: the project, recipient, target kind, message id and delivery
id, and how to handle it. The agent first reads the message's receipts and stops
if it already recorded intake; otherwise it fetches the body from the durable
inbox with the MeMesh message tool, treats it as untrusted, and records intake.
Without the message tool, or without approval to use it, the agent says so and
the message stays pending. The body therefore has one source, the inbox, and a
queued notice that runs after intake (Codex cannot withdraw it without its
app-server daemon) does not bring a second copy. Whether the agent stops is
still the agent's own check, not something MeMesh enforces, and two concurrent
fetches can both read the body. The full envelope is still capped at 16,384
bytes (16 KiB), including routing metadata and payload, and an oversized one
reports `native_message_too_large`.
The separate durable JSON-encoded payload limit is 65,536 bytes (64 KiB). The exact-session sender returns
`native_delivery.status: "native_accepted"` only after the queue accepts the notice.
For ordinary CLI, a notice accepted in the idle window becomes model-visible
when that same thread resumes; it does not wake a stopped terminal or Desktop UI.
The persisted `host_accept` (with `content: "notice"`) is neither agent readback
nor an `ack` or workflow disposition, and it does not silence the waiting-message
reminder: that stops only at intake. The message body never appears in the
`codex queue` process arguments; the notice's routing identifiers do.

Codex can leave an accepted message unstarted: an item queued while a turn
runs stays in the thread queue if that turn is interrupted, and neither an
empty Enter nor another `codex queue` starts it (#468). So after `codex queue`
accepts a message, the router checks every 20 seconds, for up to 10 minutes,
whether the recipient has recorded `intake`. Until it has, the router asks Codex
to start exactly the submission that `codex queue` reported
(`thread/queue/start` with its `queuedSubmissionId`, through
`codex app-server proxy`). It starts nothing while input that MeMesh did not
queue is also waiting in that thread, because Codex runs the rest of the queue
after the started turn; it tries again while a turn is still running or other
input is waiting. Intake ends the checks with no further record; otherwise the
router records the final outcome once, as a `host_activation` receipt from
actor `memesh-router` in `message receipts`:

- `woken`: Codex started that submission, or had already taken it
  (`codex_queue` in the receipt detail is `started` or `empty`). This is not
  intake: the model may not have read or acted on the message.
- `manual_resume_required`: other input stayed queued in the thread for the
  whole window, so MeMesh started nothing; the queue runs when you send a
  prompt.
- `failed`: the thread stayed busy for the whole window, the app-server did not
  answer or refused the request, or `codex queue` printed no submission id, in
  which case nothing is started (`reason` in the receipt detail).
- `unsupported`: Codex runs without its app-server daemon, for example a TUI
  started with `--no-daemon`. A queued MeMesh message can then stay stuck after
  an interrupted turn until you send a prompt.

`memesh doctor` reads the last 7 days of the release's own `host_activation`
receipts and, for each Codex thread, looks at the newest one. It reports a
WARN naming every thread whose newest receipt says `no_daemon`: a message
queued there is still waiting for a prompt, so send that thread one (and
avoid `--no-daemon` next time). Otherwise, including when no release ran in the window, the row is informational (`[INFO]`) and never fails; if the receipts cannot be read it is a WARN. A database from before the message tables existed shows no such row.

The checks live in the router process; a router restart drops the ones still
pending.

If the target Codex session is stopped, missing, disconnected, or no
longer matches its configured workspace, MeMesh does not start or replace it.
An exact-session send reports `recipient_unavailable`; durable scoped recovery
and receipt history remain available to fetch, cursor recovery, `poll`, or
`memesh message watch` for audit and diagnosis. Exact-session failures are not
automatically replayed through the native channel on a later registration; the
sender must retry deliberately if live delivery is still wanted.

### Separate: MeMesh-managed Codex app-server runner

```bash
memesh-host-codex --config "$HOME/.memesh/hosts/codex.json"
```

This is separate from `codex-session`: it starts a MeMesh-owned `codex
app-server`, creates its own thread through the private Unix/WebSocket control
path, and registers only after that thread is ready. If that Codex ends while
the host is still connecting to the router, the start fails (exit 1) instead of
leaving a registered host. It does not attach to an ordinary Codex session. Message content never appears in MeMesh or Codex
process arguments.

### Claude channel runner

When `memesh doctor` runs from a Claude Code plugin cache, or from an npm-global install that finds one, its default
`Claude Channel registration` row inspects only the user-scoped
`mcpServers.memesh-channel` entry in Claude's canonical user config and the
owner-private config file named by its `--config` argument. Missing
registration is a warning: durable MCP/inbox messaging can still work, while
live Channel notification remains inactive until the upstream research-preview
channel is explicitly opted into. A malformed, stale, or insecure target is
also a warning. `CONFIGURED` means only that the declaration and target are
coherent; it does not verify development-channel admission or that an agent
surfaced the notification.

Run the command `memesh agent setup claude` printed (`Register once:`, or `registration_command` with `--json`) once to add `memesh-channel` as a
user-scoped stdio MCP server. Claude owns that process for the session:

```bash
claude mcp add --transport stdio --scope user memesh-channel -- \
  memesh-host-claude --config "$HOME/.memesh/hosts/claude.json"
```

Claude Channels is an upstream research-preview opt-in. Custom channels are
not on Anthropic's approved allowlist, so start every participating Claude
session with the printed launch command and confirm the local-development
warning:

```bash
claude --dangerously-load-development-channels server:memesh-channel
```

Without that flag Claude may initialize the ordinary MCP transport while
silently dropping channel events; a MeMesh `host_accept` then proves only that
the bounded message was written to stdio, not that Claude surfaced it. With the
channel admitted, initialization registers the exact MeMesh session
(under the Claude Code session id) automatically; EOF, MCP close, or normal signals unregister it.

### Experimental ACP runner (not release-gated)

An internal generic ACP runner remains an experimental adapter surface. No ACP
provider is documented as a supported native-wakeup path here; protocol or
process readiness alone is not proof that a provider accepted a message.
If the agent process of a started ACP runner exits, or the runner fails after
start, `memesh-host-acp` unregisters, prints the cause (the exit code or
signal, or the failure) on stderr and exits 1, also when a SIGINT or SIGTERM
arrives after the agent failed. Closing it with SIGINT or SIGTERM before any
failure exits 0 and is not reported as a failure; if that close itself fails,
it prints why and exits 1.

The managed Codex app-server and Claude channel paths deliver only while their
configured target is active and registered. If it is stopped, missing, disconnected, or replaced, MeMesh keeps the durable message but does not start
the host, recreate the session, or silently redirect an exact-session target.
A later eligible managed-principal registration drains only post-activation
pending work; an exact-session target never moves to a replacement. Manual
cursor reads remain available for audit and diagnostics, not as a requirement
for active Codex-session delivery.

## What Works Today

- MCP, HTTP, and CLI use the same message lifecycle and SQLite system of record.
- A pair of participants in one project can send 30 new logical messages within 10 minutes, counting both directions. The next send fails with `conversation_loop_suspected` without storing any new message rows; ask your user before continuing. Known sessions keep different conversations separate, `/clear` aliases stay one session, and comparisons without a known session use the principal name. Exact retries still work at the limit, and automatic principal fallback counts only once.
- `send` creates one canonical message, recipient delivery, and payload-free notification event under an idempotency key. Exact-session success additionally requires native host acceptance; an oversized envelope returns `native_message_too_large`, an unreachable local router returns `router_unreachable`, and other unavailable or rejected sessions return `recipient_unavailable`, with recovery state preserved for all three outcomes. A principal send may name `intended_session`; a session send may set `fallback_to_principal` (#497, above).
- Successful sends include `delivery_note`: principal delivery confirms storage and says whether a session of the recipient is connected at that moment (when the send names `intended_session`, whether that session is; if it is not, only it can take the message in, and a session id that never registered here or belongs to another principal is called out as such; a fallback result is the exception: read `fallback.intended_session_connected`), and exact-session delivery confirms adapter acceptance, neither implies the recipient or model read or accepted the message. Reusing an existing message reports its previous ID without creating another message; an unconfirmed notification may still be attempted again. A retry that first creates a principal fallback reports that new stored message. Fallback details remain in `fallback`; when the intended session is not connected, `fallback.note` explains that only it can take the message in, separate from the principal-delivery note.
- `poll` and `memesh message watch` return only events for the exact project and recipient. They are compatibility and diagnostic paths; the opaque cursor can be persisted and reused after a timeout, dropped hint, duplicate delivery, or process restart.
- `fetch` returns the payload only to the named recipient and matching `target_kind` in the named project. Exact-session messages require `target_kind=session`; polling and fetching do not acknowledge the message.
- `intake`, `ack`, `disposition`, and `activation` are explicit, separate, idempotent receipt facts. `intake` and `disposition` for a delivery with an `intended_session` are refused (`intended_for_other_session`) unless the caller is that session, and an `ack` or an `activation` is refused when the caller names another session. Inbox/MCP ACK is valid without a host-native acceptance; host-native ACK remains bound to its `host_accept`. `receipts` returns one ordered projection and identifies each underlying fact source. For example, `manual_resume_required` does not imply ACK, acceptance, rejection, cancellation, or completion. A call that names a session registered under a different principal than the message's is refused by these actions, and by `status`, `fetch` and `receipts` (except that the message's sender may read `status` of what it sent), in the words used for a message that does not exist; `poll` shows such a session an empty inbox. For a message meant for one session, another session of the same principal is refused by `intake`, `disposition`, `ack` and `activation`, while `status`, `fetch` and `receipts` stay open to the principal's sessions; a call with no session id (HTTP has none) is refused `intake` and `disposition` for such a message too, but not `ack` or `activation`. The refusal of a session registered under another principal is cooperative, not a security boundary, and not "only the recipient can write": it does not apply to a call with no session id (HTTP has none), a session id nobody registered, an id from another project, a caller that only claims to be the recipient, or any process that opens the database file. An `intended_session` written in other letters than its registration is stored as registered (an id nobody registered, in lower case); a session id must be ASCII (a non-ASCII one is refused at registration, at send and in `CLAUDE_CODE_SESSION_ID` / `CODEX_THREAD_ID`); session ids are compared without regard to case, but two registrations that differ only in case are two sessions, and an id written exactly as one of them names that one. A receipt's `actor` is the recipient the call names (the router's own `activation` receipts use `memesh-router`); `detail.caller_session` records the session that made the call, or `null`, outside the idempotency check.
- The `host_accept` fact in `receipts` carries a `delivery_state` observed at read time: whether intake is `recorded` or `pending`, and whether the session it was accepted for is `live`, `not_live`, `unknown` (no registry row names it) or `not_applicable` (plain principal delivery). A session-target or `intended_session` message whose session ended before intake shows `pending` with `not_live`; nobody else is reminded of it and MeMesh does not resend or reroute it, and a MeMesh send cannot wake or resume that session. The sender can resume it in its own host (which may not succeed at once) and read receipts again, or decide to send it again to the principal, knowing the original session may still take the first message if it comes back. `not_live` is an observation, not a permanent end. Nothing is stored for this; older readers see the same stored facts.
- The transport, rather than model-provided payload data, records sender-host provenance.

## Repeatable owner-run live checks

These checks use a built candidate to distinguish message storage or host acceptance from a model-visible reply. They are optional for ordinary use; release requirements and receipt interpretation are in [CONTRIBUTING.md](../../CONTRIBUTING.md#cutting-a-release). An exit code or `host_accept` alone does not prove that the recipient model saw or acted on a message.

```bash
TMPDIR=/private/tmp npm run qa:live-journey -- --core-only --out .qa/core-report.json
MEMESH_CODEX_QA_HOME="$(mktemp -d "$HOME"/.memesh-codex-qa.XXXXXX)"
CODEX_HOME="$MEMESH_CODEX_QA_HOME" codex login
TMPDIR=/private/tmp npm run qa:live-journey -- --host codex --codex-home "$MEMESH_CODEX_QA_HOME" --out .qa/codex-report.json
TMPDIR=/private/tmp npm run qa:live-journey -- --host claude --out .qa/claude-report.json
```

`--core-only` needs no host login and checks memory round trip, SessionStart briefing, quiet-commit capture, Stop capture, and packed upgrade against disposable state. It does not establish Codex or Claude delivery. The host modes require an interactive, authenticated owner environment and write private reports under gitignored `.qa/`. Keep `TMPDIR=/private/tmp` on macOS so the temporary router socket path fits the platform limit. Create the disposable `CODEX_HOME` outside an OS temporary directory: Codex CLI may refuse to start there.

The disposable `CODEX_HOME` contains a real logged-in credential after `codex login`. When the run ends, including after failure, verify its path is the directory just created and remove that directory; do not leave it in your home folder or delete your normal `~/.codex`. The check's MeMesh data directory is temporary and removed on exit, unless `--keep` is requested or the runner keeps it for safety because a host session was still connected (it then prints `Kept working directory:`). It does not clean the disposable Codex login for you.

The Codex mode installs the candidate plugin into that disposable home and exercises one real CLI thread through SessionStart, native delivery, resume, and stopped-session fallback. A passing report needs model-visible readback, not only queue acceptance. The Codex queue carries only a notice, so the proof turn must fetch the body through the MeMesh `message` tool, record intake, and quote a sentinel that exists only in that body; the runner approves that one tool (`mcp_servers.memesh.tools.message.approval_mode = "approve"`) in the disposable `CODEX_HOME`, runs the MeMesh server from a rewritten `config.toml` entry with the journey's `MEMESH_DIR` and `MEMESH_DB_PATH` passed explicitly (so the plugin's own `cwd` and Codex's approval prompts are not exercised), requires an intake receipt written by the thread itself, and rejects any command in the turn other than reading the installed skill file, any tool other than the message tool (the one tolerated exception is the plugin's own failing `work_package prepare` probe), and any message action beyond receipts, fetch and intake for that one message. It also requires the fetch result to contain the sentinel and the thread's rollout to hold the queued notice without it. The Claude mode is interactive: inspect `/mcp` and `/hooks` before confirming isolation, since `--setting-sources ""` does not guarantee installed MeMesh hooks are absent. Stop if you cannot identify an extra MeMesh integration: it could write to your real database. Follow the runner's trusted prompt and wait for the model's intake; a reminder after delivery or transport acceptance alone is not equivalent. Claude print mode (`claude -p`) is not supported by this check.

For a stopped or disconnected exact session, `recipient_unavailable` must be paired with a healthy router discovery and a durable fetch: together they show the router answered and refused for that session, and that the message is still stored. A sender that cannot reach the router gets `router_unreachable` instead. Neither case restarts a host or proves the workflow completed. Review the JSON report's `limitations` and visible evidence before relying on either host result.

## Scope identifiers

`project` and `recipient` together key one inbox, and `actor` is derived from
`recipient`, so how those three are spelled is part of the contract rather than
a formatting detail. Two spellings of one name are two inboxes: the recipient
that fetches under one never sees what was sent under the other, and a
`briefing` unread count is computed per spelling.

Every message action canonicalises them to Unicode NFC and trims surrounding
whitespace, on reads as well as writes, so a decomposed spelling reaches the
rows a composed one wrote.

A value spelled as an **absolute filesystem path is refused** — a POSIX path
(`/root`), a Windows drive path (`C:\work`), or a UNC path (`\\host\share`).
Project identity is derived from the working directory and can never take that
shape, so such a value is not an identity MeMesh produced; the error names the
field and a valid value. Callers that previously passed a home directory or a
checkout path where the agent's or project's NAME belonged must pass the name.
Nothing else is rewritten: identifiers are compared exactly, case included, and
an identifier that merely contains a separator (`team/reviewer`) is accepted.
MeMesh does not treat any prefix as a namespace, so `claude-code:reviewer` and
`reviewer` are two different recipients.

The same rule covers every surface that reads or writes that key, not only the
`message` tool: `briefing` counts deliveries with no recorded intake for one exact (`project`, `recipient`), and `memesh agent setup --principal` writes the
principal half of the identity a host will register under (the project half
is derived automatically — see the setup section above, #474). A path-shaped
value is refused there too, at the moment the config is written, rather than
surfacing later as an error about some other agent's send.

`sender` is not covered by any of this. It is provenance rather than routing —
it keys no inbox, and it keys the send idempotency record — so it is trimmed but not otherwise rewritten — no NFC canonicalisation and no path refusal — and the transport-bound provenance remains the field to trust.

Rows written before this rule are preserved byte-for-byte. MeMesh reports
path-shaped historical scope through its read-only memory invariant rather than
guessing that `/root`, `/tmp/root`, and `root` name one recipient. Such rows may
remain unreachable through the stricter public API until the owner supplies an
explicit mapping. For a confirmed project mapping, rename both its entity tags
and message scopes with the deliberate owner-run operation:

```bash
memesh kg rename-project --from <old> --to <new>          # dry run
memesh kg rename-project --from <old> --to <new> --apply  # backs up first
```

## Identity and lifecycle

A **principal** is the stable logical recipient. A **session** is one live host connection for that principal. A **generation** changes when that session is replaced. A host that stalled past its lease (a laptop that slept, for example) is not replaced but expired: the router answers one of its requests (a heartbeat, for example) with `stale_generation`, and the host registers again under a new generation, waiting longer each time the router keeps doing so. The replaced host is told so, and stops: it can no longer receive. `memesh-host-claude`, `memesh-host-codex` and `memesh-host-acp` print `replaced by a newer connection for this session; stopping.` on stderr, close and exit 0; the Codex session companion writes that line to `codex-companion.log` in the data directory and exits. A close that fails, or a failure that came first, still exits 1. Stopping the replaced host leaves the newer connection registered. An exact-session target never reroutes. A principal target can deliver only to an eligible active session after its activation checkpoint; it does not replay historical inbox contents into a first session.

Persistence, dispatch attempt, host acceptance, intake, acknowledgement,
workflow disposition, retention, and presence are independent state axes. An active exact Claude Channel session receives a bounded full message without polling or an inbox fetch; a Claude inbox or Codex session receives a notice and reads the body from the inbox. An oversized full envelope returns
`native_message_too_large`. A stopped, missing, busy beyond its queue limit,
disconnected, or unsupported session returns `recipient_unavailable` and is
not awakened, resumed, or replaced; durable state remains available for audit
and recovery, subject to exact-session and activation-checkpoint rules and to
the one-day limit on a message (see "Bounded storage and audit retention").

## Bounded storage and audit retention

**A message is kept for one day.** Read or unread, a message is deleted one day
after it was sent, together with its delivery, receipts, acknowledgements and
workflow records. MeMesh does this by itself while its router, MCP server or
`memesh serve` is running; there is no command to run and no setting to change.
A message past its day is already invisible to `poll`, `fetch`, `status`,
receipts and the unread count in your session briefing, even before it has been
deleted from disk. A message sent to `person/handle@machine` on another computer
is kept, and expires, the same way: its retries stop no later than its day, and it
is not exempt.

- **The content stays one more day, in a local archive.** Before a message is
  deleted, MeMesh copies it, and every record deleted with it, into
  `backups/agent-messages-expired.db` next to your database (owner-only
  permissions; a database file other than `knowledge-graph.db`, say `work.db`,
  has its own `backups/agent-messages-expired-work.db`, so two databases in one
  folder never share an archive). A copy is removed from the archive one day after it was made, so
  the content of a message exists for about two days in all: one day as a
  message and one day in the archive. If the archive cannot be written or its
  copy does not match, nothing is deleted and `memesh doctor` says why; for a
  message to another computer the archive also holds the bridge's delivery row
  (state, attempts, last error code), so what the network did can still be read
  there; the same
  same goes for an archive path that is a symlink (wherever it points: MeMesh
  never writes its archive through one), or a file there that is not a database (MeMesh leaves such a file as
  it is). A
  database that cannot be written is left alone and reported the same way. One
  that another program has locked is not waited on: the cleanup stops at once,
  keeps what it had already done, and is reported as busy; the next one runs five
  minutes later. If the lock kept it from writing even its own record, the next
  cleanup of the same process writes that record, marked late, and `memesh doctor`
  names such a lock as a possible reason when it finds no record at all.
- **A message nobody answered tells its sender.** This is the one full statement
  of the rule; other documents point here. A message counts as answered when, in
  its own project, its recipient recorded intake, an acknowledgement, a
  disposition or a workflow record for it, or replied to it (`reply_to` set to
  its id). The reply may come from the recipient, from a session of the recipient
  sending under its own session id, or, for a message sent to a session, from
  that session's principal. The sender's own follow-up, a reply from anyone else
  or from another project, and a host accepting a push do not count. A session
  send that its session refused and that went to the session's principal instead
  (`fallback_to_principal`) is one message: the notice names the principal copy,
  which is the message id the sender got back, and an answer to that copy
  answers both. When a message expires unanswered,
  the sender receives one message from `memesh` that lists what expired (id,
  recipient, when it was sent and when it expired; up to 20, with the number
  left out). One run writes one such message per sender and project, however
  many of its messages expire. For a message sent to another computer, MeMesh
  cannot know what happened there, so the notice says what this computer knows:
  that it was not delivered (with the last error code), or that it was delivered
  to that computer but no reply from there was seen here. If the bridge already told
  the sender it refused or gave up on that message, the expiry notice does not repeat it. Read it like any other message: `poll` your own
  recipient id, then `fetch`. A message the recipient did act on or reply to
  expires silently. These notices expire after a day too, and an unread notice
  does not produce another.
- **The first run after an upgrade** begins deleting the messages older than a
  day, including ones nobody ever read, and sends these notices for them. One run
  deletes at most 20,000 messages and the next follows five minutes later, until
  none is left. A message with a delivery in progress in the last ten minutes
  waits for the next run.
- **Reading, asking the `status` of, or recording a receipt for, an expired message** returns
  `message_expired` with the id and the time it expired, instead of "not
  available". Only the message's sender and its recipient are told; anyone else
  gets the ordinary "not available". A reply from its sender or recipient that
  sets `reply_to` to an expired id is refused the same way, and nothing is stored,
  for as long as MeMesh remembers the id (30 days); send it again without
  `reply_to` and say what it answers. A reply from anyone else, to an id MeMesh
  has no record of, or after those 30 days, is stored as it always was. Retrying a reply that
  was stored while its parent still existed returns that reply. MeMesh remembers
  an expired id, who sent it and to whom, and when it was sent (no content) for
  30 days so it can say this.
- **Resending with the same `idempotency_key` after a message expired** sends a
  new message, even in the minutes before the old one is deleted from disk.
- **To get a deleted message back,** while it is still in the archive (a day
  after it was deleted), run this in a shell. It puts the messages that are in
  the archive back into the inbox for another day and changes nothing that is
  there now; running it twice does no harm. You do not need to stop MeMesh. If
  you keep your database elsewhere it follows `MEMESH_DB_PATH`, or `MEMESH_DIR`;
  the archive is found beside the database's real file even when that path is a
  symlink, and a path with a quote in it works too.

  ```bash
  DB="${MEMESH_DB_PATH:-${MEMESH_DIR:-$HOME/.memesh}/knowledge-graph.db}"
  REAL="$(sqlite3 "$DB" "SELECT file FROM pragma_database_list WHERE name = 'main'")"
  case "$(basename "$REAL")" in
    knowledge-graph.db) ARCHIVE="$(dirname "$REAL")/backups/agent-messages-expired.db" ;;
    *) ARCHIVE="$(dirname "$REAL")/backups/agent-messages-expired-$(basename "$REAL")" ;;
  esac
  ls -l "$REAL" "$ARCHIVE"
  ARCHIVE_SQL="$(printf '%s' "$ARCHIVE" | sed "s/'/''/g")"
  sqlite3 "$DB" <<SQL
  ATTACH '$ARCHIVE_SQL' AS archive;
  BEGIN;
  INSERT OR IGNORE INTO agent_messages (message_id, project, sender, sender_host, recipient, content_type, correlation_id, reply_to_message_id, privacy, payload_json, payload_sha256, payload_original_bytes, payload_tombstoned_at, provenance_json, created_at)
    SELECT message_id, project, sender, sender_host, recipient, content_type, correlation_id, reply_to_message_id, privacy, payload_json, payload_sha256, payload_original_bytes, payload_tombstoned_at, provenance_json, CURRENT_TIMESTAMP FROM archive.agent_messages;
  INSERT OR IGNORE INTO agent_message_deliveries (delivery_id, message_id, project, recipient, target_kind, intended_session, created_at)
    SELECT delivery_id, message_id, project, recipient, target_kind, intended_session, CURRENT_TIMESTAMP FROM archive.agent_message_deliveries;
  INSERT OR IGNORE INTO agent_message_events (event_id, message_id, delivery_id, project, recipient, event_kind, created_at)
    SELECT event_id, message_id, delivery_id, project, recipient, event_kind, CURRENT_TIMESTAMP FROM archive.agent_message_events;
  DELETE FROM agent_message_expiries WHERE message_id IN (SELECT message_id FROM archive.agent_messages);
  COMMIT;
  SQL
  ```

  To bring back only some of them, add the same `WHERE` (for example
  `WHERE recipient = 'bob'`) to the first `SELECT`, and the matching
  `WHERE message_id IN (SELECT message_id FROM archive.agent_messages WHERE recipient = 'bob')`
  to the other three. To only read them, open the archive on its own:
  `sqlite3 -readonly "$ARCHIVE" "SELECT message_id, sender, recipient, created_at, payload_json FROM agent_messages"`.
  A restored message comes back as a new, unread message with a fresh day (its
  receipts and acknowledgements are not restored), and is deleted and archived
  again a day later. A restored message addressed to another computer is not sent
  again: the bridge reports it to its sender as refused (`message_invalid`). Its
  old delivery row stays readable in the archive.
- **Old session records go too.** Session presence records and ended session
  connections older than a day are cleared in the same run (nothing reads them
  once a session has ended). A session that is still connected is never touched.
  Your `poll` cursors keep working after the events they pointed at are gone.

`memesh doctor` shows when the last run happened, what it deleted, and warns if
it is failing or messages are piling up. Inspect storage with:

```bash
memesh message storage report
```

It reports message counts, how many are past their day and waiting to be
deleted, reusable SQLite pages, main/WAL file sizes, and the last run. Freed
SQLite pages become reusable; the main database file is a high-watermark and is
not promised to shrink. Full `VACUUM` is never run by a hook or by this cleanup.

An owner may set `MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES` to a non-negative
integer. This is a hard **logical payload** budget, not a whole SQLite file or
disk quota. The canonical send transaction checks it before inserting any
message effect; an over-quota send fails with "Agent message storage quota exceeded." (error code `storage_quota_exceeded` in the library; HTTP reports `errorCode: "operation.failed"`) and leaves
no partial message, delivery, event, idempotency, dispatch, or receipt row.
Metadata, indexes, reusable pages, and WAL bytes still consume disk and remain
visible in the report; keep separate filesystem headroom and monitoring.
Heartbeats refresh the connection lease in place; they do not append one audit
row every interval. There is deliberately no default quota.

## Local and Cloud boundary

This guide describes one local MeMesh instance: its SQLite durable event store
and same-machine host-native input. Computers that joined one team by invite
(`memesh network`) also exchange the messages agents send, addressed
`person/handle@machine`, through `relay.memesh.ai` (or your own relay) or
directly; memory never crosses, and the receiving machine stores each message in
its own instance like any other. Cloud state is not evidence that this local
host accepted a native message. Native
acceptance, persistence, or fetch does not promise exactly-once cognition, a
reply, or a stopped-session wake-up.

## What This Is Not Yet

- Not universal host support or stopped-session resume. This document only
  describes the explicitly configured ordinary Codex path and the separate
  managed Codex/Claude paths above.
- Not topic, broadcast, or lease/claim routing, and no per-message lifetime: every message is kept one day, read or not, then deleted (see "Bounded storage and audit retention"). The current delivery target is one exact recipient.
- Not arbitrary external-user access. Cross-machine delivery reaches only computers whose owners joined your team by invite; a local MeMesh instance is not a public collaboration service.
- Not permission to execute payload content. The receiving host must apply its own policy and required human approval.

## Support Matrix

| Participant | Current path | Status today | Notes |
|---|---|---|---|
| Ordinary Codex CLI | automatic plugin SessionStart registration; optional `codex-session` identity override | short native notice while active; the agent fetches the message body | Exact thread identity is discoverable; oversized envelopes return `native_message_too_large`, while stopped or disconnected sessions return `recipient_unavailable` |
| MeMesh-managed Codex app-server | `memesh-host-codex` | separate managed path | It creates its own Codex thread; it does not attach to an ordinary session |
| Ordinary Claude MCP | `claude-inbox` | native notice when the host supplies its socket | Exact-session sends require a new matching receive record; unavailable sockets keep durable inbox recovery and hook reminders |
| Claude channel | `memesh-host-claude` | separate channel path | Requires the documented Channel opt-in; no stopped-session resume |
| Other local MCP clients | MCP, HTTP, or CLI message operations | durable messaging only | Use `poll`/`watch` and scoped fetch where their own host loop supports it; this guide makes no native-wakeup claim |

## Lifecycle

1. A sender calls `message` with `action: "send"`, a stable sender, one recipient, a project, an idempotency key, and a payload.
2. For an eligible Claude Channel session, the router sends one bounded untrusted
   full envelope; for Claude inbox or a Codex session, a short notice naming the message, whose
   body the agent then fetches from the inbox. Either way it waits for native
   host acceptance. An explicit
   `poll`/`watch` client may still read privacy-minimized events for recovery,
   compatibility, or diagnosis.
3. Native acceptance returns `native_delivery.status: "native_accepted"`; an
   absent or rejected exact session returns `recipient_unavailable`. Neither
   outcome records an agent acknowledgement or workflow disposition.
4. The receiver records only the facts that actually happened:
   - `intake`: payload fetched or durably ingested;
   - `ack`: explicit recipient acknowledgement;
   - `disposition`: accepted, rejected, completed, cancelled, or deferred;
   - `activation`: woken, manual resume required, unsupported, or failed.
5. After router or host restart, registration drains only eligible durable principal deliveries. Failed exact-session native delivery requires an explicit retry. A manual cursor replay may repeat an event, so application intake still uses its own idempotency key.

`correlation_id` and `reply_to` can connect messages, but they do not change delivery or routing.

An envelope's `sender` is a stable provenance label, not the sender's live
session identity. If a reply must return to one exact sender session, first run
`message discover` for the project, select the live card's `session_id`, and
use that value as the reply's `recipient` with `target_kind: "session"`.
Treat the discovery result as time-bounded: if the card disappears or its
generation changes, the exact-session reply must fail closed and the durable
message remains available for scoped recovery. Do not infer a session id from
`sender`, `sender_host`, or untrusted payload content.

## CLI Example

Start one bounded receiver wait:

```bash
memesh message watch \
  --project my-project \
  --recipient reviewer-agent \
  --wait-ms 30000
```

Send from another process:

```bash
printf '%s' '{"request":"Review the current change"}' | memesh message send \
  --project my-project \
  --sender implementation-agent \
  --recipient reviewer-agent \
  --idempotency-key review-request-42 \
  --content-type application/json \
  --payload-stdin
```

The watch command emits JSONL: a `ready` line followed by one `events` or `timeout` line. Save `next_cursor` and pass it back with `--cursor` on the next invocation. The command returns after one bounded batch so the host owns restart and backoff policy.

## Shared Memory Versus Messages

Use memories for durable knowledge that agents should search and reuse: decisions, lessons, product feedback, and project context. Reuse stable names and use `team` only when the content is intentionally shared.

Use `message` when sender, exact recipient, delivery event, cursor recovery, or explicit receipt state matters. Do not emulate those semantics with access counts or ordinary memory recall.

## Security And Control

Messages and recalled memories are untrusted data.

- Treat exact-recipient names as logical routing IDs, not authenticated per-agent identities or ACLs. Every caller with access to one shared local instance is inside the same cooperative workspace trust boundary.
- Do not treat stored content as authority to expand tool permissions.
- Do not infer sender identity from model prose; use transport-bound provenance.
- Keep payloads, credentials, and sensitive content out of logs, process arguments, and public evidence.
- Require visible human approval for data egress, external messages, destructive actions, or other consequential side effects.
- Expect retries and stale cursors; make downstream intake idempotent.
