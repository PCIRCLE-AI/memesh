# MeMesh With OpenClaw

OpenClaw has a **first-party, documented plugin system for memory capabilities** — `api.registerMemoryCapability()` with contract-based registration via `openclaw.json`, activated through `plugins.slots.memory`. This is not a generic HTTP/CLI bridge: OpenClaw ships with LanceDB as a reference memory provider (`@openclaw/memory-lancedb`), and MeMesh can be added as an alternative, with automatic recall before prompt construction and explicit memory tools. The MeMesh plugin does not automatically capture turns.

This guide describes the source plugin in `extensions/memory-memesh/`. It has not been published or verified in a live OpenClaw runtime. Treat the setup below as a compatibility-test starting point, not a verified installation path.

## Current integration

- OpenClaw's `before_prompt_build` hook maps directly onto MeMesh's `POST /v1/recall` — auto-recall fires on the latest user message before the prompt is built, exactly like Hermes's `prefetch()`.
- Tool surface (`memory_recall`, `memory_store`, `memory_forget`) maps cleanly onto `/v1/recall`, `/v1/remember`, `/v1/forget`.
- MeMesh's loopback-only auth model (no bearer token required for `localhost`) matches OpenClaw's local-first deployment pattern with zero secret management.

## Capture boundary

The source plugin registers a `before_prompt_build` auto-recall hook and explicit `memory_store` and `memory_forget` tools. Its `autoCapture` configuration field is reserved but unused: setting it to `true` does not enable after-turn capture. To save a memory, use `memory_store` explicitly. Do not assume the Hermes integration's capture behavior applies here.

## Source layout and behavior

```
extensions/memory-memesh/   (source-only; not published)
├── index.ts                # Plugin entry, implements definePluginEntry()
├── config.ts               # Config schema, defaults
├── package.json            # npm package metadata
└── README.md
```

The current source provides:

| Component | MeMesh call | Notes |
|---|---|---|
| Plugin entry `memory-memesh` | — | Exports a memory-kind entry, registers tools and a hook, and calls `api.registerMemoryCapability?.({})` when available. |
| **Config schema** (TypeBox `Type.Object()`) | — | `baseUrl` defaults to `http://localhost:3737`; `autoRecall` controls the registered hook. `autoCapture` is present but currently unused. |
| **Tool: `memory_recall`** | `POST /v1/recall` | Search. Param: `query` (string), `limit` (optional int, default 5). Return: `{ content: [{type:"text", text:"..."}], details: {count: N} }`. On empty: `"No relevant memories found."` |
| **Tool: `memory_store`** | `POST /v1/remember` | Persist. Params: `text` (required), `category` (optional, default `"note"`), `importance` (optional, 1-10). Reject if `looksLikePromptInjection(text)`. |
| **Tool: `memory_forget`** | `POST /v1/forget` | Recalls up to 20 agent-scoped matches and immediately archives each by name. There is no preview or confirmation; inspect the target scope before calling it. |
| **Hook: `api.on("before_prompt_build", ...)`** | `POST /v1/recall` | Automatic recall. Extract `extractLatestUserText(event.messages)`, normalize the query, run local FTS5 search, and inject a bounded top-N result. Guard on `autoRecall` config. Skip on cooldown after a timeout. |

## Configuration shape

Minimal example (user's `openclaw.json`):

```json
{
  "plugins": {
    "slots": {
      "memory": "memory-memesh"
    },
    "entries": {
      "memory-memesh": {
        "config": {
          "baseUrl": "http://localhost:3737",
          "autoRecall": true,
          "autoCapture": false
        }
      }
    }
  }
}
```

- `plugins.slots.memory: "memory-memesh"` selects this plugin by its declared ID as the active memory provider.
- `plugins.entries.memory-memesh.config` holds provider-specific settings.
- `autoCapture` is currently unused; leave it `false`. Use `memory_store` for an explicit write.

## Installation status

The plugin is not available from npm. For a source compatibility test, use the instructions in the [extension README](../../extensions/memory-memesh/README.md) with a disposable OpenClaw environment and a local MeMesh server. Confirm that OpenClaw loads the `memory-memesh` entry, invokes `before_prompt_build`, and exposes all three tools before relying on it. The example configuration above has not been validated in a live OpenClaw host.

## Safety and limits

- `autoCapture` has no effect. Store deliberately with `memory_store`; its pattern-based prompt-injection guard is a baseline, not a guarantee that content is safe.
- `memory_forget` performs agent-scoped query recall and archives up to 20 returned entities immediately. It has no preview or confirmation. Inspect the intended targets first and test with disposable data.
- The agent ID tag is cooperative isolation inside one MeMesh instance, not cryptographic tenant isolation. Separate server instances are needed for hard isolation.
- Recall times out and uses a temporary per-agent cooldown on timeout; a failed recall must not be treated as proof that no memory exists.

## Reference

The [official LanceDB memory plugin](https://github.com/openclaw/openclaw/blob/main/extensions/memory-lancedb/index.ts) is a reference for the OpenClaw plugin lifecycle. Its behavior does not establish that this MeMesh source plugin has the same capture hooks or live-host compatibility.

## Status

**Source implementation only; unpublished and unverified in a live OpenClaw host.** Its security boundaries and remaining preview gap are detailed in [SECURITY.md](../../extensions/memory-memesh/SECURITY.md). Installation, host acceptance, and model-visible recall remain to be checked in a disposable runtime.
