#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { markdownSection } from './lib/markdown-section.mjs';

const ACTIONS = ['discover', 'send', 'read', 'status'];
const CLI_ACTIONS = { discover: 'discover', send: 'send', read: 'read', status: 'status' };
const option = process.argv.indexOf('--root');
const root = option < 0 ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') : path.resolve(process.argv[option + 1] ?? '');
const missing = [];
function read(file) {
  try { return fs.readFileSync(path.join(root, file), 'utf8'); }
  catch { missing.push(`${file} (missing)`); return ''; }
}
function pattern(file, regex, description) {
  if (!regex.test(read(file))) missing.push(`${file} (missing ${description})`);
}
function tokens(file, list) {
  const source = read(file);
  for (const value of list) if (!source.includes(value)) missing.push(`${file} (missing ${JSON.stringify(value)})`);
}

// The routing upgrade backfills only newly added internal columns, once. Do not
// exempt the same SQL in send/read/maintenance, or any change to public contents.
function withoutRoutingBackfill(source) {
  const upgrades = [...source.matchAll(/^([ \t]+)(?:private )?upgradeRoutingSchema\(\)(?:: void)? \{[\s\S]*?^\1\}/gm)];
  if (upgrades.length !== 1) return source;
  const [upgrade] = upgrades;
  const method = upgrade[0];
  if (!method.includes("this.db.prepare('PRAGMA table_info(messages)')")
    || !/if\s*\(columns\.some\(c\s*=>\s*c\.name\s*===\s*'sender_local'\)\)\s*return;/.test(method)
    || !method.includes('this.db.transaction(() => {') || !method.includes('}).immediate();')) return source;
  const statements = [
    "UPDATE messages SET sender_local=1 WHERE kind != 'legacy';",
    "UPDATE messages SET recipient_local=1 WHERE kind != 'legacy' AND recipient_host IS NOT NULL;",
    "UPDATE messages SET sender_local=1 WHERE kind='legacy' AND sender_machine!='unknown' AND sender NOT LIKE 'legacy:%';",
    "UPDATE messages SET recipient_local=1 WHERE kind='legacy' AND recipient_machine!='unknown' AND recipient NOT LIKE 'legacy:%';",
  ];
  if (statements.some(statement => method.split(statement).length !== 2)) return source;
  const checked = statements.reduce((text, statement) => text.replace(statement, ''), method);
  return source.replace(method, checked);
}

// The public MCP and CLI share the conversation schema. Legacy HTTP is separate.
for (const file of ['src/transports/conversation-messaging.ts', 'dist/transports/conversation-messaging.js']) {
  const source = read(file);
  const section = /ConversationMessageActionSchema = z\.discriminatedUnion\('action', \[([\s\S]*?)\]\);/.exec(source)?.[1] ?? '';
  const found = [...section.matchAll(/action:\s*z\.literal\('([^']+)'\)/g)].map(m => m[1]);
  if (found.join(',') !== ACTIONS.join(',')) missing.push(`${file} (conversation actions must be exactly ${ACTIONS.join(', ')})`);
  pattern(file, /ConversationMessageActionSchema\.parse\(input\)/, 'action schema validation');
  pattern(file, /store\.send\(context\.session!?,\s*action\)/, 'session-bound sender');
  tokens(file, ['CONVERSATION_MESSAGE_INPUT_SCHEMA', 'z.toJSONSchema(ConversationMessageActionSchema)', '!context.session']);
}
for (const file of ['src/transports/mcp/handlers.ts', 'dist/transports/mcp/handlers.js']) {
  pattern(file, /name:\s*'message',\s*description:\s*CONVERSATION_MESSAGE_DESCRIPTION,\s*inputSchema:\s*CONVERSATION_MESSAGE_INPUT_SCHEMA/, 'MCP message schema wiring');
  pattern(file, /await executeConversationMessageAction\(args,\s*\{\s*session:\s*requestContext\.hostSession\s*\}\)/, 'MCP awaited session-bound handler');
}
for (const file of ['src/core/schema-export.ts', 'dist/core/schema-export.js']) {
  pattern(file, /description:\s*CONVERSATION_MESSAGE_DESCRIPTION,\s*parameters:\s*CONVERSATION_MESSAGE_INPUT_SCHEMA/, 'exported message schema wiring');
}
for (const file of ['src/transports/cli/cli.ts', 'dist/transports/cli/cli.js']) {
const cli = read(file);
const start = cli.indexOf('conversationMessageCmd =');
const end = cli.indexOf('legacyMessageCmd =', start);
const publicCli = start >= 0 && end > start ? cli.slice(start, end) : '';
const commands = [...publicCli.matchAll(/\.command\(["']([^"']+)["']\)/g)].map(m => m[1]);
if (commands.join(',') !== ['message', ...ACTIONS].join(',')) missing.push(`${file} (public message commands must be exactly four actions)`);
for (const [action, command] of Object.entries(CLI_ACTIONS)) {
  const part = publicCli.split(new RegExp(`\\.command\\(["']${command}["']\\)`))[1]?.split(/\.command\(/)[0] ?? '';
  if (!new RegExp(`action:\\s*["']${action}["']`).test(part)) missing.push(`${file} (CLI command "${command}" mapped to action "${action}")`);
}
if (!/body:\s*await readConversationMessageBodyFromStdin\(\)/.test(publicCli) || !publicCli.includes('--payload-stdin') || !publicCli.includes('never argv')) missing.push(`${file} (message body must come from stdin)`);
if (!/session:\s*conversationSession\(["']send["']\)/.test(publicCli)) missing.push(`${file} (session-bound sender)`);
}
for (const file of ['src/core/conversation-messages.ts', 'dist/core/conversation-messages.js']) {
  tokens(file, ['MESSAGE_MAX_BYTES = 8_000', "Buffer.byteLength(renderConversationMessage(message), 'utf8') > MESSAGE_MAX_BYTES", "'message_too_large'", "'unknown_recipient'", 'message.body = null', "reason ? 'rejected' : 'queued'", '14 * DAY', 'requirePrivateWritableDirectory', '0o700', '0o600']);
  pattern(file, /requirePrivateWritableDirectory\(path\.dirname\(file\),\s*'messages must remain owner-private'\)/, 'owner-private directory guard call');
  pattern(file, /const tooLarge = Buffer\.byteLength\(renderConversationMessage\(message\), 'utf8'\) > MESSAGE_MAX_BYTES;\s*const reason = tooLarge \? 'message_too_large' : !to \? 'unknown_recipient' : undefined;\s*if \(tooLarge\)\s*message\.body = null;/, 'rendered-byte limit and rejection branch');
  pattern(file, /this\.insert\(message(?:,\s*\{[^;{}]*\})?\);\s*this\.event\(message\.id, reason \? 'rejected' : 'queued', \{ actor: from\.id, \.\.\.\(reason \? \{ reason \} : \{\}\) \}\);\s*if \(reason\)\s*return \{ message, accepted: false, reason,/, 'send insert and rejected audit event');
  if (/\b(?:UPDATE|DELETE FROM)\s+(?:messages|events)\b/i.test(withoutRoutingBackfill(read(file)).replace(/DELETE FROM messages WHERE sent_at <= \?/g, ''))) missing.push(`${file} (message/event mutation outside expiry)`);
}
const section = markdownSection(read('docs/api/API_REFERENCE.md'), 'message');
const rows = section === null ? [] : [...section.matchAll(/^\| `([^`]+)` \|/gm)].map(m => m[1]);
if (rows.join(',') !== ACTIONS.join(',')) missing.push('docs/api/API_REFERENCE.md (message action rows must be exactly four actions)');
for (const file of ['dist/mcp/server.js', 'dist/transports/http/server.js']) read(file);
for (const file of ['src/transports/http/server.ts', 'dist/transports/http/server.js']) {
  tokens(file, ['MessageBody', 'executeAgentMessageAction', "transport: 'http'"]);
}
tokens('.claude-plugin/mcp.json', ['memesh', '${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.js']);
tokens('.claude-plugin/plugin.json', ['"name": "memesh"', '"version"', '"mcpServers": "./.claude-plugin/mcp.json"']);
tokens('.codex-plugin/plugin.json', ['"name": "memesh"', '"version"', '"mcpServers": "./.codex-plugin/mcp.json"']);
tokens('.codex-plugin/mcp.json', ['"mcpServers"', '"memesh"', '"command": "node"', '"args": ["./dist/mcp/server.js"]', '"cwd": "."']);
tokens('.claude-plugin/marketplace.json', ['"name": "pcircle-memesh"', '"version"']);
if (fs.existsSync(path.join(root, '.mcp.json'))) missing.push('.mcp.json (must not exist: Claude discovers it as project-scoped)');
tokens('hooks/hooks.json', ['session-start.js', 'session-summary.js', 'pre-compact.js', 'user-prompt-intent.js', 'prompt-recall.js', 'pre-edit-recall.js', 'guard-check.js', 'post-commit.js', 'codex-session.js', 'startup|resume', 'SessionEnd']);
tokens('package.json', ['"^22.23.5 || ^24.22.3 || ^26.13.1"', 'check-agent-message-sync.mjs', 'test:packaged']);
if (missing.length) {
  process.stderr.write(`agent-message-sync: FAIL (${missing.length} drift item(s))\n`);
  for (const item of missing) process.stderr.write(`  - ${item}\n`);
  process.exit(1);
}
process.stdout.write(`agent-message-sync: PASS (${ACTIONS.length} actions, conversation contract and installed artifacts)\n`);
