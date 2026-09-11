"""MeMesh memory plugin — MemoryProvider interface.

Local-first knowledge-graph memory via the MeMesh HTTP API (`memesh serve`,
default http://localhost:3737). Loopback-only, no bearer token needed.

Configuration
-------------
Non-secret (lives in $HERMES_HOME/memesh.json, set via `hermes memory setup`):
  base_url  — MeMesh HTTP server URL (default: http://localhost:3737)

No secrets required for a local loopback deployment.
"""

from __future__ import annotations

import json
import logging
import queue
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

from agent.memory_provider import MemoryProvider

logger = logging.getLogger(__name__)

_PREFETCH_WAIT_SECS = 3
# Turns waiting for capture. A full queue drops the turn (logged) rather than
# ever making sync_turn wait: sync_turn runs on Hermes's main thread.
_TURN_QUEUE_MAX = 8
_DEFAULT_BASE_URL = "http://localhost:3737"
_RECALL_LIMIT = 5
# Session capture runs synchronously at a session/compression boundary (see
# Pitfall 5 in docs/platforms/hermes-agent.md); the bound keeps a wedged
# `memesh` process from holding up Hermes's shutdown.
_CAPTURE_TIMEOUT_SECS = 20.0
_TURN_TIMEOUT_SECS = 30.0


def _load_config(hermes_home: str) -> dict:
    config_path = Path(hermes_home) / "memesh.json"
    if config_path.exists():
        try:
            return json.loads(config_path.read_text())
        except Exception:
            return {}
    return {}


def _resolve_memesh_bin() -> Optional[str]:
    # shutil.which() depends on PATH, which systemd user services set
    # explicitly and narrowly — check well-known npm-global locations too
    # so activation (and capture) doesn't silently fail if PATH wasn't
    # updated. See Pitfall 2.
    found = shutil.which("memesh")
    if found:
        return found
    for candidate in (
        Path.home() / ".npm-global" / "bin" / "memesh",
        Path("/usr/local/bin/memesh"),
    ):
        if candidate.exists():
            return str(candidate)
    return None


class MemeshProvider(MemoryProvider):
    """Persistent knowledge-graph memory backed by a local MeMesh server."""

    @property
    def name(self) -> str:
        return "memesh"

    # -- lifecycle ------------------------------------------------------

    def is_available(self) -> bool:
        # No network calls — just check the CLI binary is installed.
        return _resolve_memesh_bin() is not None

    def initialize(self, session_id: str, **kwargs) -> None:
        hermes_home = kwargs.get("hermes_home", "")
        cfg = _load_config(hermes_home)
        self._base_url = cfg.get("base_url", _DEFAULT_BASE_URL)
        self._session_id = session_id
        # cron/subagent/flush contexts should not pollute long-term memory —
        # only the primary interactive agent writes.
        self._agent_context = kwargs.get("agent_context", "primary")
        self._client = httpx.Client(base_url=self._base_url, timeout=5.0)

        self._prefetch_lock = threading.Lock()
        self._prefetch_thread: Optional[threading.Thread] = None
        self._prefetch_query: Optional[str] = None
        self._prefetch_result: Optional[str] = None
        # One worker drains turns in order, so captures never pile up as
        # concurrent `memesh` processes contending for the SQLite write lock.
        self._turn_queue: "queue.Queue[tuple]" = queue.Queue(maxsize=_TURN_QUEUE_MAX)
        self._turn_worker: Optional[threading.Thread] = None

    def system_prompt_block(self) -> str:
        # Deliberately minimal. Recall/storage already happen automatically
        # via prefetch()/sync_turn() on every turn — this block must not
        # read as an invitation to proactively reorganize memory (built-in
        # MEMORY.md/USER.md included). It exists only so the model knows
        # explicit memesh_* tools are available as a narrow backstop.
        return (
            "MeMesh auto-recalls relevant memory each turn; you don't need "
            "to call memesh_recall yourself for that. Only call "
            "memesh_remember/memesh_recall/memesh_forget for a specific, "
            "narrow lookup or correction the automatic recall missed — not "
            "as a cue to reorganize or rewrite existing memory files."
        )

    def shutdown(self) -> None:
        try:
            self._client.close()
        except Exception:
            pass

    # -- recall / prefetch ------------------------------------------------

    def _do_recall(self, query: str) -> str:
        try:
            resp = self._client.post(
                "/v1/recall", json={"query": query, "limit": _RECALL_LIMIT}
            )
            resp.raise_for_status()
            data = resp.json()
            if not data.get("success"):
                return ""
            # API_REFERENCE.md documents `data` as an object with an
            # `entities` array, but the live HTTP /v1/recall response (memesh
            # 4.5.1) returns `data` as a bare array of entities directly.
            # Handle both shapes defensively — see PCIRCLE-AI/memesh#159.
            payload = data.get("data")
            if isinstance(payload, list):
                entities = payload
            elif isinstance(payload, dict):
                entities = payload.get("entities", [])
            else:
                entities = []
            if not entities:
                return ""
            lines = ["[MeMesh recall]"]
            for e in entities:
                obs = "; ".join(e.get("observations", [])[:3])
                lines.append(f"- ({e.get('type')}) {e.get('name')}: {obs}")
            return "\n".join(lines)
        except Exception as exc:
            logger.warning("MeMesh recall failed: %s", exc)
            return ""

    def _start_prefetch(self, query: str) -> None:
        with self._prefetch_lock:
            if self._prefetch_thread and self._prefetch_thread.is_alive():
                return

        def _run() -> None:
            result = self._do_recall(query)
            with self._prefetch_lock:
                self._prefetch_query = query
                self._prefetch_result = result

        with self._prefetch_lock:
            self._prefetch_thread = threading.Thread(target=_run, daemon=True)
            self._prefetch_thread.start()

    def _consume_prefetch_result(self, query: str) -> Optional[str]:
        with self._prefetch_lock:
            if self._prefetch_query == query and self._prefetch_result is not None:
                result = self._prefetch_result
                self._prefetch_query = None
                self._prefetch_result = None
                return result
        return None

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        self._start_prefetch(query)

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        cached = self._consume_prefetch_result(query)
        if cached is not None:
            return cached
        self._start_prefetch(query)
        with self._prefetch_lock:
            thread = self._prefetch_thread
        if thread:
            thread.join(timeout=_PREFETCH_WAIT_SECS)
        cached = self._consume_prefetch_result(query)
        # Slow/unreachable backend: skip injection rather than block the turn.
        # memesh_recall tool remains the backstop.
        return cached or ""

    # -- sync_turn --------------------------------------------------------

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
        messages: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        if self._agent_context != "primary":
            logger.debug("MeMesh turn capture skipped: not the primary agent (%s)", self._agent_context)
            return
        sid = session_id or self._session_id

        # Every turn is handed to memesh, but memesh stores it only when the
        # reply states a decision or a lesson (src/core/turn-signal.ts) —
        # ordinary chatter is not memory. Never blocks: sync_turn fires every
        # turn on the host's main thread.
        item = (sid, user_content or "", assistant_content or "")
        try:
            self._turn_queue.put_nowait(item)
        except queue.Full:
            logger.warning("MeMesh capture skipped: queue full (%s turns waiting)", _TURN_QUEUE_MAX)
            return
        if self._turn_worker is None or not self._turn_worker.is_alive():
            self._turn_worker = threading.Thread(target=self._drain_turns, daemon=True)
            self._turn_worker.start()

    def _drain_turns(self) -> None:
        while True:
            # Blocking get, no idle exit: an exiting worker could race a put
            # that saw it still alive and strand that turn.
            sid, user_text, assistant_text = self._turn_queue.get()
            try:
                self._run_capture(
                    ["hermes", "capture-turn", "--session", sid],
                    {"user": user_text, "assistant": assistant_text},
                    _TURN_TIMEOUT_SECS,
                )
            except Exception as exc:
                logger.warning("MeMesh turn capture failed: %s", exc)
            finally:
                self._turn_queue.task_done()

    # -- compression / session-end capture ------------------------------------
    #
    # At a session or compression boundary the message list goes through the
    # SAME extractor the Claude Code Stop hook uses (src/core/session-insight.ts):
    # edited files, errors fixed, a heavy session's commands — stored as
    # `session-<id>-files/-fixes/-summary`, not as a transcript dump. A
    # later boundary in the same session appends to those entities; memesh
    # refuses identical observations, so overlap between the pre-compression
    # list and the session-end list is not duplicated.

    def _run_capture(self, args: List[str], payload: Dict[str, Any], timeout: float) -> Optional[Dict[str, Any]]:
        # Writes go through the `memesh` CLI, not `POST /v1/remember`: the
        # HTTP route stamps every write `source_host: http`, and these must be
        # attributed to `hermes`. The payload travels on stdin, never argv
        # (argv is visible to every local process via `ps`). Every outcome is
        # logged — a capture that silently did nothing looks exactly like one
        # that was never attempted.
        binary = _resolve_memesh_bin()
        if binary is None:
            logger.warning("MeMesh capture skipped: `memesh` CLI not found on PATH")
            return None
        try:
            proc = subprocess.run(
                [binary, *args],
                input=json.dumps(payload),
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            logger.warning("MeMesh capture timed out after %ss: %s", timeout, " ".join(args[:2]))
            return None
        except Exception as exc:
            logger.warning("MeMesh capture failed to start: %s", exc)
            return None
        if proc.returncode != 0:
            logger.warning(
                "MeMesh capture failed (exit %s): %s",
                proc.returncode,
                (proc.stderr or "").strip()[:500],
            )
            return None
        try:
            result = json.loads(proc.stdout.strip().splitlines()[-1])
        except Exception:
            logger.warning("MeMesh capture returned unreadable output: %s", proc.stdout[:200])
            return None
        if not isinstance(result, dict):
            logger.warning("MeMesh capture output is not a JSON object: %s", proc.stdout[:200])
            return None
        if result.get("toolResultsNonJson"):
            logger.info(
                "MeMesh capture: %s tool result(s) were not JSON, so errors in them were not counted",
                result["toolResultsNonJson"],
            )
        if result.get("unrecognizedTools"):
            logger.info("MeMesh capture: unrecognized tool names %s", result["unrecognizedTools"])
        logger.info(
            "MeMesh capture %s: %s",
            result.get("outcome"),
            result.get("reason") or result.get("written") or result.get("name"),
        )
        return result

    def _capture_session(self, messages: Optional[List[Dict[str, Any]]]) -> Optional[Dict[str, Any]]:
        # Deliberately SYNCHRONOUS, unlike sync_turn(). on_session_end runs
        # immediately before shutdown(); a detached thread racing that
        # reliably lost the write (Pitfall 5). These fire once per boundary,
        # so blocking briefly adds no per-turn latency.
        if self._agent_context != "primary":
            logger.debug("MeMesh session capture skipped: not the primary agent (%s)", self._agent_context)
            return None
        if not messages:
            logger.info("MeMesh session capture skipped: no messages")
            return None
        return self._run_capture(
            ["hermes", "capture-session", "--session", self._session_id],
            {"messages": messages},
            _CAPTURE_TIMEOUT_SECS,
        )

    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        self._capture_session(messages)
        return (
            "What this session did so far (files edited, errors fixed) is "
            "recorded in MeMesh — recall via memesh_recall if needed later — "
            "so the summary here can stay concise rather than exhaustive."
        )

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        self._capture_session(messages)

    def on_session_switch(
        self,
        new_session_id: str,
        *,
        parent_session_id: str = "",
        reset: bool = False,
        rewound: bool = False,
        **kwargs,
    ) -> None:
        # self._session_id is cached at initialize() and read by prefetch/
        # sync_turn/archive helpers — without updating it here, a mid-process
        # /reset, /resume, or /branch would keep tagging new memories with
        # the stale pre-switch session_id.
        self._session_id = new_session_id
        if reset:
            with self._prefetch_lock:
                self._prefetch_query = None
                self._prefetch_result = None

    # -- explicit tools -----------------------------------------------------

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [
            {
                "name": "memesh_remember",
                "description": "Store a fact, decision, pattern, or lesson in persistent memory.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "description": "Unique entity name"},
                        "type": {
                            "type": "string",
                            "description": "Entity type, e.g. decision, lesson, pattern, fact",
                        },
                        "observations": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Key facts or observations",
                        },
                        "tags": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": ["name", "type"],
                },
            },
            {
                "name": "memesh_recall",
                "description": "Search persistent memory for relevant past knowledge.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"},
                        "tag": {"type": "string"},
                    },
                },
            },
            {
                "name": "memesh_forget",
                "description": "Archive or remove a memory entity by name.",
                "parameters": {
                    "type": "object",
                    "properties": {"name": {"type": "string"}},
                    "required": ["name"],
                },
            },
        ]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        try:
            if tool_name == "memesh_remember":
                resp = self._client.post("/v1/remember", json=args)
            elif tool_name == "memesh_recall":
                resp = self._client.post("/v1/recall", json=args)
            elif tool_name == "memesh_forget":
                resp = self._client.post("/v1/forget", json=args)
            else:
                raise NotImplementedError(
                    f"memesh provider does not handle tool {tool_name}"
                )
            resp.raise_for_status()
            return json.dumps(resp.json())
        except Exception as exc:
            return json.dumps({"success": False, "error": str(exc)})

    # -- config ------------------------------------------------------------

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {
                "key": "base_url",
                "description": "MeMesh HTTP server URL",
                "default": _DEFAULT_BASE_URL,
            },
        ]

    def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
        config_path = Path(hermes_home) / "memesh.json"
        config_path.write_text(json.dumps(values, indent=2))


def register(ctx) -> None:
    """Called by the memory plugin discovery system."""
    ctx.register_memory_provider(MemeshProvider())
