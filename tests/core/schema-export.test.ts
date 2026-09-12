import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { exportOpenAITools } from '../../src/core/schema-export.js';
import { BriefingSchema, LearnSchema, MessageSchema, RememberSchema, RecallSchema, WorkPackageSchema } from '../../src/transports/schemas.js';
import { TOOL_DEFINITIONS } from '../../src/transports/mcp/handlers.js';
import { AGENT_MESSAGE_JSON_MAX_BYTES, AGENT_NATIVE_MESSAGE_MAX_BYTES } from '../../src/core/agent-messaging.js';

const objectVariants = (schema: any): any[] => Array.isArray(schema.oneOf) ? schema.oneOf : [schema];

describe('exportOpenAITools', () => {
  const tools = exportOpenAITools();

  it('exports one tool per MCP tool, counted from the registry itself', () => {
    // This used to assert the literal 9, next to a name list that was also a
    // literal, under a title claiming it "matches MCP registry" — it matched
    // nothing, it restated. Retiring `consolidate` made both wrong at once,
    // which is what a duplicated list is for. Counted from the registry now.
    expect(Array.isArray(tools)).toBe(true);
    expect(TOOL_DEFINITIONS.length, 'the MCP registry is empty — this test would pass on nothing').toBeGreaterThan(0);
    expect(tools).toHaveLength(TOOL_DEFINITIONS.length);
  });

  it('each tool has type "function" and a function object with name, description, parameters', () => {
    for (const tool of tools) {
      const t = tool as any;
      expect(t.type).toBe('function');
      expect(t.function).toBeDefined();
      expect(typeof t.function.name).toBe('string');
      expect(typeof t.function.description).toBe('string');
      expect(t.function.parameters).toBeDefined();
      expect(t.function.parameters.type).toBe('object');
      for (const schema of objectVariants(t.function.parameters)) {
        expect(schema.type).toBe('object');
        expect(schema.properties).toBeDefined();
      }
    }
  });

  it('exports exactly the MCP tool names, prefixed, in registry order', () => {
    const names = tools.map((t: any) => t.function.name);
    expect(names).toEqual(TOOL_DEFINITIONS.map((t) => `memesh_${t.name}`));
  });

  it('memesh_work_package exports the strict Zod oneOf contract for every action', () => {
    const tool = tools.find((t: any) => t.function.name === 'memesh_work_package') as any;
    const parameters = tool.function.parameters;

    expect(parameters).toEqual({ type: 'object', ...z.toJSONSchema(WorkPackageSchema) });
    expect(parameters.oneOf.map((variant: any) => variant.properties.action.const)).toEqual(['prepare', 'submit', 'defer']);
    expect(parameters.oneOf.every((variant: any) => variant.additionalProperties === false)).toBe(true);
    expect(parameters.oneOf[0].properties.kind.enum).toEqual(['digest', 'transcript']);
    expect(parameters.oneOf[1].properties.ref.oneOf.map((ref: any) => ref.properties.kind.const)).toEqual(['digest', 'transcript']);
    expect(parameters.oneOf[1].properties.ref.oneOf.every((ref: any) => ref.additionalProperties === false)).toBe(true);
    const transcriptRef = parameters.oneOf[1].properties.ref.oneOf.find((ref: any) => ref.properties.kind.const === 'transcript');
    expect(transcriptRef.required).toContain('workspace_hash');
    expect(parameters.oneOf[1].properties.result.properties.type.enum).toEqual(['digest', 'decision', 'lesson_learned', 'fact']);
    expect(parameters.oneOf[1].properties.result.additionalProperties).toBe(false);
  });

  it('memesh_import requires data and merge_strategy', () => {
    const tool = tools.find((t: any) => t.function.name === 'memesh_import') as any;
    expect(tool.function.parameters.required).toEqual(['data', 'merge_strategy']);
    expect(tool.function.parameters.properties.merge_strategy.description).not.toMatch(/default/i);
  });

  it('memesh_export has no required fields (all optional filters)', () => {
    const tool = tools.find((t: any) => t.function.name === 'memesh_export') as any;
    expect(tool.function.parameters.required).toBeUndefined();
  });

  it('memesh_remember states the two complete forms, not "nothing is required" (#324 C7)', () => {
    const tool = tools.find((t: any) => t.function.name === 'memesh_remember') as any;
    // Dropping `required: ['name','type']` when `note` arrived left the
    // exported schema saying every field is optional — so a model driven off
    // this export is told an empty call is well-formed, and learns otherwise
    // only from a runtime error. The rule is `note`, OR `name` + `type`, OR
    // `name` + `replace: true` (the correction call, which inherits the
    // stored type — #333 T4).
    expect(tool.function.parameters.anyOf).toEqual([
      { required: ['note'] },
      { required: ['name', 'type'] },
      { required: ['name', 'replace'], properties: { replace: { const: true } } },
    ]);
    // `required` stays absent: a top-level list would be a THIRD claim, and
    // neither field is unconditionally required.
    expect(tool.function.parameters.required).toBeUndefined();
  });

  it('the three forms the export declares are exactly the three the runtime accepts', () => {
    expect(RememberSchema.safeParse({ note: 'a thought' }).success).toBe(true);
    expect(RememberSchema.safeParse({ name: 'n', type: 'decision', observations: ['x'] }).success).toBe(true);
    expect(RememberSchema.safeParse({ name: 'n', replace: true, observations: ['x'] }).success).toBe(true);
    // `replace` is what makes the third form a form: without it the same
    // call is a new memory with no type, which the export does not declare.
    expect(RememberSchema.safeParse({ name: 'n', replace: false, observations: ['x'] }).success).toBe(false);
    // Neither form: refused, naming the key.
    const bad = RememberSchema.safeParse({ observations: ['x'] });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toMatch(/name is required/);
    // Half of the structured form is not a form.
    expect(RememberSchema.safeParse({ name: 'n', observations: ['x'] }).success).toBe(false);
  });

  it('memesh_recall has no required fields', () => {
    const tool = tools.find((t: any) => t.function.name === 'memesh_recall') as any;
    expect(tool.function.parameters.required).toBeUndefined();
  });

  it('memesh_forget requires name', () => {
    const tool = tools.find((t: any) => t.function.name === 'memesh_forget') as any;
    expect(tool.function.parameters.required).toEqual(['name']);
  });

  it('memesh_learn requires error and fix', () => {
    const tool = tools.find((t: any) => t.function.name === 'memesh_learn') as any;
    expect(tool.function.parameters.required).toEqual(['error', 'fix']);
  });

  it('memesh_learn exports the exact strict runtime field names', () => {
    const exported = tools.find((t: any) => t.function.name === 'memesh_learn') as any;
    const mcp = TOOL_DEFINITIONS.find((definition) => definition.name === 'learn') as any;
    const runtimeKeys = Object.keys(LearnSchema.shape);

    expect(Object.keys(exported.function.parameters.properties)).toEqual(runtimeKeys);
    expect(Object.keys(mcp.inputSchema.properties)).toEqual(runtimeKeys);
    expect(exported.function.parameters.properties).toHaveProperty('root_cause');
    expect(exported.function.parameters.properties).not.toHaveProperty('rootCause');
    expect(mcp.inputSchema.additionalProperties).toBe(false);
  });

  it('HTTP learn examples use the runtime root_cause field', () => {
    for (const file of ['docs/platforms/chatgpt.md', 'docs/platforms/universal.md']) {
      const content = fs.readFileSync(path.resolve(file), 'utf8');
      expect(content, file).toContain('"root_cause"');
      expect(content, file).not.toContain('"rootCause"');
    }
  });

  it('memesh_improvement exposes proposal/status only and keeps review authority human', () => {
    const tool = tools.find((t: any) => t.function.name === 'memesh_improvement') as any;
    expect(tool.function.parameters.required).toEqual(['action']);
    expect(tool.function.parameters.properties.action.enum).toEqual(['propose', 'status']);
    expect(tool.function.parameters.properties).not.toHaveProperty('accept');
    expect(tool.function.parameters.properties).not.toHaveProperty('reject');
    expect(tool.function.description).toMatch(/cannot accept or reject/i);
  });

  it('memesh_message exposes every action and does not collapse reads into ACK', () => {
    const tool = tools.find((t: any) => t.function.name === 'memesh_message') as any;
    expect(tool.function.parameters.required).toEqual(['action']);
    expect(tool.function.parameters.properties.action.enum).toEqual([
      'send', 'poll', 'discover', 'fetch', 'intake', 'ack', 'disposition', 'activation', 'receipts',
    ]);
    expect(tool.function.description).toMatch(/Reads never imply acknowledgement/);
    expect(tool.function.description).toContain(`${AGENT_MESSAGE_JSON_MAX_BYTES} UTF-8 bytes (64 KiB)`);
    expect(tool.function.description).toContain(`${AGENT_NATIVE_MESSAGE_MAX_BYTES} bytes (16 KiB)`);
    expect(tool.function.description).toMatch(/native_message_too_large/);
    expect(tool.function.description).toMatch(/recipient_unavailable/);
    expect(tool.function.description).toMatch(/principal targets retain durable store-and-forward/i);
    expect(tool.function.parameters.properties.payload.description).toContain('Untrusted JSON value');
    expect(tool.function.parameters.properties.payload.description).toContain(`${AGENT_MESSAGE_JSON_MAX_BYTES} UTF-8 bytes (64 KiB)`);
    expect(tool.function.parameters.properties.payload.description).toContain(`${AGENT_NATIVE_MESSAGE_MAX_BYTES} bytes (16 KiB)`);
    expect(tool.function.parameters.properties.recipient.description).toMatch(/except discover/i);
    const mcpMessage = TOOL_DEFINITIONS.find((definition) => definition.name === 'message') as any;
    expect(tool.function.parameters.properties.recipient.description)
      .toBe(mcpMessage.inputSchema.properties.recipient.description);
    expect(tool.function.parameters.properties.payload.description)
      .toContain(`${AGENT_MESSAGE_JSON_MAX_BYTES} UTF-8 bytes (64 KiB)`);

    expect(MessageSchema.safeParse({
      action: 'poll', project: 'memesh', recipient: 'codex', wait_ms: 30_001,
    }).success).toBe(false);
    expect(MessageSchema.safeParse({ action: 'poll', project: 'memesh' }).success).toBe(false);
    expect(MessageSchema.safeParse({
      action: 'ack', project: 'memesh', recipient: 'codex', message_id: 'm-1', idempotency_key: 'ack-1', disposition: 'completed',
    }).success).toBe(false);
  });

  // Non-tautological parity: derive the expected fields from the Zod schemas
  // that are the real validation source of truth, not from the export itself.
  // If someone adds a field to RememberSchema/RecallSchema, the OpenAI export
  // must expose it or an agent driven off the export can never send it — the
  // exact gap that left `relations`/`namespace` off `remember` and made every
  // agent-created entity an orphan.
  it('memesh_remember exposes every field in RememberSchema (incl. relations, namespace)', () => {
    const tool = tools.find((t: any) => t.function.name === 'memesh_remember') as any;
    const exported = Object.keys(tool.function.parameters.properties);
    const zodKeys = Object.keys(RememberSchema.shape);
    for (const key of zodKeys) {
      expect(exported, `RememberSchema.${key} missing from OpenAI export`).toContain(key);
    }
    // Guard against silent regression on the two that were missing.
    expect(exported).toContain('relations');
    expect(exported).toContain('namespace');
  });

  it('memesh_recall exposes every field in RecallSchema (incl. include_archived, cross_project)', () => {
    const tool = tools.find((t: any) => t.function.name === 'memesh_recall') as any;
    const exported = Object.keys(tool.function.parameters.properties);
    const zodKeys = Object.keys(RecallSchema.shape);
    for (const key of zodKeys) {
      expect(exported, `RecallSchema.${key} missing from OpenAI export`).toContain(key);
    }
    expect(exported).toContain('include_archived');
    expect(exported).toContain('cross_project');
    expect(exported).toContain('namespace');
  });

  it('memesh_briefing exposes the optional exact recipient scope', () => {
    const tool = tools.find((t: any) => t.function.name === 'memesh_briefing') as any;
    const exported = Object.keys(tool.function.parameters.properties);
    expect(exported).toEqual(Object.keys(BriefingSchema.shape));
    expect(tool.function.parameters.properties.recipient.description).toMatch(/exact logical recipient/i);

    const mcp = TOOL_DEFINITIONS.find((definition) => definition.name === 'briefing')!;
    expect(Object.keys(mcp.inputSchema.properties)).toEqual(Object.keys(BriefingSchema.shape));
    expect(mcp.inputSchema.properties.recipient.description).toMatch(/exact logical recipient/i);
  });

  it('the relations field is shaped as an array of {to, type} objects', () => {
    const tool = tools.find((t: any) => t.function.name === 'memesh_remember') as any;
    const rel = tool.function.parameters.properties.relations;
    expect(rel.type).toBe('array');
    expect(rel.items.type).toBe('object');
    expect(Object.keys(rel.items.properties).sort()).toEqual(['to', 'type']);
    expect(rel.items.required.sort()).toEqual(['to', 'type']);
  });

  it('all parameter properties have a type field', () => {
    for (const tool of tools) {
      const t = tool as any;
      for (const schema of objectVariants(t.function.parameters)) {
        for (const [key, value] of Object.entries(schema.properties)) {
          for (const variant of objectVariants(value)) {
            expect(variant.type, `${t.function.name}.${key} should have a type`).toBeDefined();
          }
        }
      }
    }
  });

  it('every namespace field publishes the enum the runtime actually enforces (M-12)', () => {
    // remember/recall's namespace fields carried `enum: ['personal', 'team',
    // 'global']`; export/import's did not — a bare `{type: 'string'}` next
    // to a description that only MENTIONED the three values in prose. A
    // client (or a model reading the schema, not the docs) had no
    // machine-readable way to know 'prod' would be rejected until it tried.
    const withNamespace = TOOL_DEFINITIONS.flatMap((definition: any) =>
      objectVariants(definition.inputSchema).map((schema: any) => ({ definition, schema })),
    ).filter(({ schema }) => 'namespace' in schema.properties);
    expect(withNamespace.length, 'fixture: no registered tool declares a namespace field').toBeGreaterThan(0);
    for (const { definition, schema } of withNamespace) {
      const field = schema.properties.namespace;
      expect(field.enum, `${definition.name}.namespace has no enum`).toEqual(['personal', 'team', 'global']);
    }
  });
});
