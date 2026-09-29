import { describe, expect, it } from 'vitest';
import { TOOL_DEFINITIONS } from '../src/transports/mcp/handlers.js';

describe('public MCP message tool definition', () => {
  it('advertises principal and exact-session targeting to conforming clients', () => {
    const message = TOOL_DEFINITIONS.find((tool) => tool.name === 'message');
    expect(message).toBeDefined();

    const properties = message?.inputSchema.properties as Record<string, unknown>;
    expect(properties.target_kind).toEqual(expect.objectContaining({
      type: 'string',
      enum: ['principal', 'session'],
    }));
  });

  it('#497: advertises intended_session and fallback_to_principal, and says what each does', () => {
    const message = TOOL_DEFINITIONS.find((tool) => tool.name === 'message');
    const properties = message?.inputSchema.properties as Record<string, unknown>;
    expect(properties.intended_session).toEqual(expect.objectContaining({ type: 'string' }));
    expect(properties.fallback_to_principal).toEqual(expect.objectContaining({ type: 'boolean' }));
    expect(message?.description).toContain('intended_session');
    expect(message?.description).toContain('intended_for_other_session');
  });
});
