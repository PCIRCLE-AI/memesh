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
import time
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
_RECALL_TIMEOUT_SECS = 5.0
# One turn's capture is a detached `memesh` process; the bound keeps a wedged one from living forever.
_TURN_TIMEOUT_SECS = 30.0
# How long session end + shutdown together wait for queued turns (one deadline).
_DRAIN_TIMEOUT_SECS = 5.0


def _server_error(resp) -> str:
    """The `error` sentence of a failed response, else its status line."""
    try:
        error = resp.json().get("error")
        if isinstance(error, str) and error:
            return error
    except Exception:
        pass
    return f"HTTP {resp.status_code}"


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
        self._prefetch_key: Optional[tuple] = None
        self._prefetch_generation = 0
        self._prefetch_result: Optional[dict] = None
        self._shown_ids: Dict[str, set] = {}
        # One worker drains turns in order, so captures never pile up as
        # concurrent `memesh` processes contending for the SQLite write lock.
        self._turn_queue: "queue.Queue[tuple]" = queue.Queue(maxsize=_TURN_QUEUE_MAX)
        self._turn_worker: Optional[threading.Thread] = None
        self._drain_deadline: Optional[float] = None
        self._drain_warned = False

    def system_prompt_block(self) -> str:
        # Deliberately minimal. Recall/storage already happen automatically
        # via prefetch()/sync_turn() on every turn — this block must not
        # read as an invitation to proactively reorganize memory (built-in
        # MEMORY.md/USER.md included). It exists only so the model knows
        # explicit memesh_* tools are available and that saving is on by default.
        return (
            "MeMesh auto-recalls relevant memory each turn; you don't need "
            "to call memesh_recall yourself for that. Saving is on by "
            "default: call memesh_remember for the decisions, preferences, "
            "lessons and facts that come up, without waiting to be asked; "
            "use memesh_recall/memesh_forget when the user asks to find or "
            "remove a specific stored memory, not as a cue to "
            "reorganize or rewrite existing memory files."
        )

    def _drain_turns_before_exit(self) -> None:
        # The worker is a daemon thread: whatever is still queued when Hermes
        # exits is lost. Wait for it — bounded, with ONE deadline shared by
        # on_session_end() and the shutdown() that follows it, so a stuck
        # capture cannot hold the host twice — and say what did not make it:
        # a lost capture must not look like one that never happened.
        q = getattr(self, "_turn_queue", None)
        if q is None:
            return  # never initialized: nothing was queued
        if self._drain_deadline is None:
            self._drain_deadline = time.monotonic() + _DRAIN_TIMEOUT_SECS
        # A local: another thread may reset the attribute mid-wait.
        deadline = self._drain_deadline
        while q.unfinished_tasks and time.monotonic() < deadline:
            time.sleep(0.05)
        if not q.unfinished_tasks or self._drain_warned:
            return
        self._drain_warned = True
        queued = q.qsize()
        running = q.unfinished_tasks - queued
        # An in-flight turn is a separate `memesh` process that keeps running
        # after Hermes exits and usually finishes; the queued ones never start.
        logger.warning(
            "MeMesh: %d queued turn(s) not captured before shutdown; %d capture(s) still running and may finish",
            queued,
            running,
        )

    def shutdown(self) -> None:
        self._drain_turns_before_exit()
        try:
            self._client.close()
        except Exception:
            pass

    # -- recall / prefetch ------------------------------------------------

    def _do_recall(self, query: str, session_id: str) -> dict:
        binary = _resolve_memesh_bin()
        if binary is None:
            logger.warning("MeMesh recall skipped: `memesh` CLI not found on PATH")
            return {"text": "", "ids": []}
        try:
            with self._prefetch_lock:
                exclude = sorted(self._shown_ids.get(session_id, set()))
            proc = subprocess.run(
                [binary, "hermes", "prompt-context", "--session", session_id],
                input=json.dumps({"prompt": query, "exclude": exclude}), capture_output=True,
                text=True, timeout=_RECALL_TIMEOUT_SECS,
            )
            if proc.returncode != 0:
                raise RuntimeError(f"CLI exited {proc.returncode}")
            result = json.loads(proc.stdout)
            context = result.get("text") if isinstance(result, dict) else None
            if not isinstance(context, str) or len(context.encode("utf-8")) > 4096:
                raise ValueError("CLI returned invalid or oversized context")
            ids = result.get("ids")
            if not isinstance(ids, list) or len(ids) > 2 or any(type(i) is not int or i <= 0 for i in ids):
                raise ValueError("CLI returned invalid memory IDs")
            return {"text": context, "ids": ids}
        except Exception as exc:
            logger.warning("MeMesh recall failed: %s", exc)
            return {"text": "", "ids": []}

    def _prefetch_request(self, query: str, session_id: str) -> tuple:
        with self._prefetch_lock:
            return (query, session_id or self._session_id, self._prefetch_generation)

    def _start_prefetch(self, key: tuple) -> None:
        def _run() -> None:
            result = self._do_recall(key[0], key[1])
            with self._prefetch_lock:
                self._prefetch_key = key
                self._prefetch_result = result

        with self._prefetch_lock:
            if self._prefetch_thread and self._prefetch_thread.is_alive():
                return
            self._prefetch_thread = threading.Thread(target=_run, daemon=True)
            self._prefetch_thread.start()

    def _consume_prefetch_result(self, key: tuple) -> Optional[str]:
        with self._prefetch_lock:
            if self._prefetch_key == key and self._prefetch_result is not None:
                result = self._prefetch_result
                self._prefetch_key = None
                self._prefetch_result = None
                if result["text"]:
                    self._shown_ids.setdefault(key[1], set()).update(result["ids"])
                return result["text"]
        return None

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        self._start_prefetch(self._prefetch_request(query, session_id))

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        key = self._prefetch_request(query, session_id)
        cached = self._consume_prefetch_result(key)
        if cached is not None:
            return cached
        self._start_prefetch(key)
        with self._prefetch_lock:
            thread = self._prefetch_thread
        if thread:
            thread.join(timeout=_PREFETCH_WAIT_SECS)
        cached = self._consume_prefetch_result(key)
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

        # Every turn is handed to memesh, which stores what the user said and what
        # the assistant answered, each in full (src/core/chat-turn.ts). Never
        # blocks: sync_turn fires every turn on the host's main thread.
        item = (sid, user_content or "", assistant_content or "")
        # A turn after a drain may be reported again, but it does not buy a
        # second wait: session end + shutdown share one budget. Only a real
        # new session (on_session_switch) resets the deadline.
        self._drain_warned = False
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

    # -- capture ---------------------------------------------------------------

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
        logger.info(
            "MeMesh capture %s: %s",
            result.get("outcome"),
            result.get("reason") or result.get("names"),
        )
        return result

    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        # Nothing is captured here: every turn is already stored as it happens.
        return ""

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        # shutdown() follows ~1 ms later (Pitfall 5); drain queued turns
        # first so the session's last turns are not the ones lost.
        self._drain_turns_before_exit()

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
        with self._prefetch_lock:
            self._session_id = new_session_id
            self._prefetch_generation += 1
            self._prefetch_key = None
            self._prefetch_result = None
            if reset:
                self._shown_ids.pop(new_session_id, None)
        # A new session's exit gets its own drain budget.
        self._drain_deadline = None
        self._drain_warned = False

    # -- explicit tools -----------------------------------------------------

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [
            {
                "name": "memesh_remember",
                "description": "Store a fact, decision, preference, pattern, or lesson in persistent memory. Saving is on by default: store without waiting to be asked. Use memesh_forget when the user asks to remove a specific stored memory.",
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
                        "why": {
                            "type": "string",
                            "description": "For a decision: why it was made and what would make it stop holding (optional; a decision without it is stored and shown as no reason recorded)",
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
            if resp.status_code >= 400:
                # The server's own sentence explains invalid input or an
                # unavailable write; a bare status line does not.
                return json.dumps({"success": False, "error": _server_error(resp)})
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
