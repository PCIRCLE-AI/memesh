import { expect, it, vi } from 'vitest';

const observed = vi.hoisted(() => ({
  opened: vi.fn(),
  closed: vi.fn(),
  connected: vi.fn(),
  updater: vi.fn(async () => undefined),
  server: undefined as { onclose?: () => void } | undefined,
}));

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class {
    oninitialized?: () => void;
    onclose?: () => void;
    constructor() { observed.server = this; }
    setRequestHandler() { /* No requests are needed to exercise startup. */ }
    getClientVersion() { return { name: 'claude-code', version: '1' }; }
    getClientCapabilities() { return {}; }
    async connect() { observed.connected(); this.oninitialized?.(); }
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
vi.mock('../../src/db.js', () => ({
  openDatabase: observed.opened, closeDatabase: observed.closed,
  getDatabase: vi.fn(), isDatabaseOpen: () => true,
}));
vi.mock('../../src/mcp/tools.js', () => ({ TOOL_DEFINITIONS: [], handleTool: vi.fn() }));
vi.mock('../../src/transports/mcp/handlers.js', () => ({
  configureVersionSource: vi.fn(), normalizeClientHost: (name: string) => name,
}));
vi.mock('../../src/core/auto-update.js', () => ({
  updateControlDir: () => '/unused-test-control', registerLiveHost: vi.fn(),
  logAutoUpdateLine: vi.fn(), dispatchAutoUpdate: observed.updater,
}));

it('starts and closes MCP without starting retired messaging workers', async () => {
  const signals = ['SIGINT', 'SIGTERM'] as const;
  const previous = signals.map(signal => process.listeners(signal));
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  try {
    await import('../../src/mcp/server.js');
    await vi.waitFor(() => expect(observed.updater).toHaveBeenCalledOnce());
    expect(observed.opened).toHaveBeenCalledOnce();
    expect(observed.connected).toHaveBeenCalledOnce();
  } finally {
    observed.server?.onclose?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(observed.closed).toHaveBeenCalledOnce();
    for (const [index, signal] of signals.entries()) {
      for (const listener of process.listeners(signal)) {
        if (!previous[index].includes(listener)) process.removeListener(signal, listener);
      }
    }
    exit.mockRestore();
  }
});
