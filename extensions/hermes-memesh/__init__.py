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

import hashlib
import json
import logging
import os
import queue
import re
import shutil
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
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
# Worst case the host waits at session end: the turn drain (_DRAIN_TIMEOUT_SECS,
# shared by on_session_end and shutdown) plus the session capture — 5 + 15 =
# 20 s, the same bound the session-end archive had before turns were queued.
_CAPTURE_TIMEOUT_SECS = 15.0
_TURN_TIMEOUT_SECS = 30.0
# How long session end + shutdown together wait for queued turns (one deadline).
_DRAIN_TIMEOUT_SECS = 5.0


# A private session is remembered on disk, under Hermes's own home, because
# Hermes ends the session and starts a new provider instance with the same
# session id at every /compress, /resume, /branch and /new, so neither a flag in
# memory nor the message history (a compression drops the old messages) is
# enough. The marker file holds only the session id, never any content, and is
# never removed: once written, that session id stays private.
_MARKER_DIRNAME = "memesh-private-sessions"
# Beside it, for the same reason, the sessions each session was branched or compressed from (ids only, as JSON
# {parent: true when the switch gave no reason}), so a new instance inherits privacy exactly as this one would.
_PARENTS_DIRNAME = "memesh-session-parents"
_MARKER_WRITE_FAILED = "the private-session marker could not be written"
_MARKER_READ_FAILED = "the private-session marker could not be read"
_MARKER_NO_HOME = "the private-session marker could not be kept or read: Hermes gave no home folder"
_MARKER_NO_REASON = "Hermes did not say why the session changed, so the new session is treated as private"
_MARKER_NO_SESSION_ID = "the host gave no session id, so whether the session is private cannot be told and nothing is saved"
# Skip reasons (the same sentences as SKIP_REASONS in src/core/capture-liveness.ts).
_SKIP_PRIVATE = "private_session"
_SKIP_NOT_PRIVATE = "not a private session"


def _marker_path(hermes_home: str, session_id: str, dirname: str = _MARKER_DIRNAME) -> str:
    safe = session_id if re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}", session_id or "") else hashlib.sha256(
        (session_id or "").encode("utf-8")
    ).hexdigest()
    return os.path.join(hermes_home, dirname, safe)


def _write_private_file(path: str, data: bytes) -> None:
    """Create or replace a 0600 file in a 0700 folder, whole or not at all (a temporary file renamed over it), and
    never over a symlink. Raises on failure."""
    folder = os.path.dirname(path)
    os.makedirs(folder, mode=0o700, exist_ok=True)
    if os.path.islink(path):
        raise OSError(f"{path} is a symbolic link")
    tmp = os.path.join(folder, f".{os.path.basename(path)}.{uuid.uuid4().hex}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        try:
            os.write(fd, data)
        finally:
            os.close(fd)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _outcomes_dir() -> str:
    """Where memesh keeps its records: beside MEMESH_DB_PATH, else MEMESH_DIR, else ~/.memesh; an empty value is no value (as in getMemeshDirFromDbPath)."""
    explicit = os.environ.get("MEMESH_DB_PATH")
    if explicit:
        return os.path.dirname(os.path.abspath(explicit))
    return os.environ.get("MEMESH_DIR") or os.path.join(os.path.expanduser("~"), ".memesh")


def _record_outcome(outcome: str, reason: str) -> None:
    """One outcome line for `memesh doctor` (it reads this file), best effort and never raising."""
    try:
        directory = _outcomes_dir()
        os.makedirs(directory, mode=0o700, exist_ok=True)
        line = json.dumps({
            "hook": "hermes-private-session",
            "run": uuid.uuid4().hex[:16],
            "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            "host": "hermes",
            "outcome": outcome,
            "reason": reason,
        })
        fd = os.open(
            os.path.join(directory, "hook-outcomes.jsonl"),
            os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
        try:
            os.write(fd, (line + "\n").encode("utf-8"))
        finally:
            os.close(fd)
    except Exception as exc:  # noqa: BLE001
        logger.warning("MeMesh could not record %r: %s", reason, exc)


def _messages_call_private_tool(messages: Optional[List[Dict[str, Any]]]) -> bool:
    """An assistant message with a tool call to private_session (same rule as chatCallsPrivateTool)."""
    for message in messages or []:
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        for call in message.get("tool_calls") or []:
            function = call.get("function") if isinstance(call, dict) else None
            name = function.get("name") if isinstance(function, dict) else None
            if name in ("private_session", "memesh_private_session"):
                return True
    return False


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
        self._hermes_home = hermes_home or ""

        self._prefetch_lock = threading.Lock()
        self._prefetch_thread: Optional[threading.Thread] = None
        self._prefetch_query: Optional[str] = None
        self._prefetch_result: Optional[str] = None
        # One worker drains turns in order, so captures never pile up as
        # concurrent `memesh` processes contending for the SQLite write lock.
        self._turn_queue: "queue.Queue[tuple]" = queue.Queue(maxsize=_TURN_QUEUE_MAX)
        self._turn_worker: Optional[threading.Thread] = None
        self._drain_deadline: Optional[float] = None
        self._drain_warned = False
        # Sessions the agent marked private (memesh_private_session): remembered
        # here for this instance and in a marker file for the next one (see
        # _MARKER_DIRNAME). The message history the host passes to sync_turn and
        # to `hermes capture-session` is read for the call too.
        self._private_sessions: set = set()
        # The parents this instance recorded at a switch ({parent: no reason given}), kept here too in case the
        # file under _PARENTS_DIRNAME could not be written.
        self._parents: Dict[str, Dict[str, bool]] = {}
        # Sessions already recorded as checked and not private by this instance, so a healthy session records once.
        self._recorded_checks: set = set()

    def _mark_private(self, session_id: str) -> bool:
        """Mark a session private here and on disk. Returns False when the marker file could not be written."""
        self._private_sessions.add(session_id)
        if not self._hermes_home:
            logger.warning("MeMesh private-session marker not written: no Hermes home was given")
            _record_outcome("error", _MARKER_NO_HOME)
            return False
        try:
            _write_private_file(_marker_path(self._hermes_home, session_id), session_id.encode("utf-8"))
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("MeMesh private-session marker could not be written: %s", exc)
            _record_outcome("error", _MARKER_WRITE_FAILED)
            return False

    def _privacy(self, session_id: str, messages: Optional[List[Dict[str, Any]]] = None, _walk: bool = True) -> tuple:
        """Is this session private? ("yes" | "no" | "unchecked", reason).

        The same decision as decidePrivacy in src/core/private-session.ts, for
        what Hermes has: a call in the message list or the marker under the
        Hermes home is "yes"; a marker that cannot be looked at, no home to look
        in, or no session id is "unchecked" (the caller saves nothing and the
        next capture decides again: it is never remembered as private); no
        marker is "no". tests/fixtures/private-state-cases.json holds the cases
        both sides run.
        """
        if session_id and session_id in self._private_sessions:
            return ("yes", None)
        if _messages_call_private_tool(messages):
            if session_id:
                self._mark_private(session_id)
            return ("yes", None)
        if not session_id:
            return ("unchecked", _MARKER_NO_SESSION_ID)
        if not self._hermes_home:
            return ("unchecked", _MARKER_NO_HOME)
        path = _marker_path(self._hermes_home, session_id)
        try:
            os.lstat(path)
        except FileNotFoundError:
            return self._inherited_privacy(session_id) if _walk else ("no", None)
        except OSError as exc:
            logger.warning("MeMesh private-session marker could not be read, so nothing is saved this time: %s", exc)
            return ("unchecked", _MARKER_READ_FAILED)
        self._private_sessions.add(session_id)
        return ("yes", None)

    def _parents_of(self, session_id: str) -> tuple:
        """({parent: no reason given}, None) from this instance and the file on disk, or ({}, reason) when unreadable."""
        parents: Dict[str, bool] = {}
        try:
            if not self._hermes_home:
                raise FileNotFoundError  # no home: only this instance's own record (a capture reports the missing home)
            fd = os.open(_marker_path(self._hermes_home, session_id, _PARENTS_DIRNAME), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            try:
                data = json.loads(os.read(fd, 1 << 20).decode("utf-8"))
            finally:
                os.close(fd)
            if not isinstance(data, dict):
                raise ValueError("not a JSON object")
            parents = {str(p): bool(guess) for p, guess in data.items()}
        except FileNotFoundError:
            pass
        except (OSError, ValueError) as exc:
            logger.warning("MeMesh session parents could not be read, so nothing is saved this time: %s", exc)
            return ({}, _MARKER_READ_FAILED)
        for parent, guess in self._parents.get(session_id, {}).items():
            parents[parent] = parents.get(parent, True) and guess
        return (parents, None)

    def _add_parents(self, session_id: str, parents: List[str], guess: bool) -> None:
        """Record at a switch where the new session came from, here and on disk (a reasoned switch wins over a guess)."""
        known, unreadable = self._parents_of(session_id)
        for parent in parents:
            if parent != session_id:
                known[parent] = known.get(parent, True) and guess
        self._parents[session_id] = known
        if not self._hermes_home:
            return  # every capture of it already stops and records the missing home
        try:
            if unreadable:
                raise OSError(unreadable)  # writing now would drop what the file already holds
            _write_private_file(_marker_path(self._hermes_home, session_id, _PARENTS_DIRNAME), json.dumps(known).encode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            logger.warning("MeMesh session parents could not be written: %s", exc)
            _record_outcome("error", _MARKER_WRITE_FAILED)

    def _inherited_privacy(self, session_id: str) -> tuple:
        """A session with no marker of its own is private when a session it was branched or compressed from is.

        Looked up at every capture, in this instance or a new one: a parent's marker that could not be read at the
        switch may be read now. A parent reached through a switch that gave no reason makes the session
        "unchecked", never private for good. Each session is looked at once, so a cycle ends the walk.
        """
        seen = {session_id}
        pending = [(session_id, False)]
        while pending:
            current, guessed = pending.pop(0)
            parents, unreadable = self._parents_of(current)
            if unreadable:
                return ("unchecked", unreadable)
            for parent, guess in parents.items():
                if parent in seen:
                    continue
                seen.add(parent)
                state, reason = self._privacy(parent, _walk=False)
                if state == "yes" and (guessed or guess):
                    return ("unchecked", _MARKER_NO_REASON)
                if state == "yes":
                    self._mark_private(session_id)
                    return ("yes", None)
                if state == "unchecked":
                    return (state, reason)
                pending.append((parent, guessed or guess))
        return ("no", None)

    def _private_exit(self, session_id: str, messages: Optional[List[Dict[str, Any]]] = None) -> bool:
        """Decide, record, and say whether this capture must not run. Every exit leaves an outcome."""
        state, reason = self._privacy(session_id, messages)
        if state == "yes":
            _record_outcome("skipped", _SKIP_PRIVATE)
            return True
        if state == "unchecked":
            _record_outcome("error", reason)
            return True
        # A checked, ordinary session is recorded once per instance: it is what clears an old error in doctor.
        if session_id not in self._recorded_checks:
            self._recorded_checks.add(session_id)
            _record_outcome("skipped", _SKIP_NOT_PRIVATE)
        return False

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
            "the only exception is the user explicitly asking you not to "
            "save. Use memesh_recall/memesh_forget for a specific lookup or "
            "correction the automatic recall missed — not as a cue to "
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
        # After a restart the flag is gone, but the history the host passes still
        # holds the call: read it the way `memesh hermes capture-session` does.
        if self._private_exit(sid, messages):
            logger.info("MeMesh turn capture skipped: private session, or one that cannot be checked")
            return

        # Every turn is handed to memesh, but memesh stores it only when the
        # reply states a decision or a lesson (src/core/turn-signal.ts) —
        # ordinary chatter is not memory. Never blocks: sync_turn fires every
        # turn on the host's main thread.
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
                # A marker written while the turn waited: decided again, and the exit recorded.
                if self._private_exit(sid):
                    logger.info("MeMesh turn capture skipped: private session, or one that cannot be checked")
                    continue
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
        if isinstance(result.get("error"), str):
            # memesh could not check the session against its own private-sessions folder, so it saved nothing.
            _record_outcome("error", result["error"])
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
        if self._private_exit(self._session_id, messages):
            logger.info("MeMesh session capture skipped: private session, or one that cannot be checked")
            return None
        return self._run_capture(
            ["hermes", "capture-session", "--session", self._session_id],
            {"messages": messages},
            _CAPTURE_TIMEOUT_SECS,
        )

    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        self._capture_session(messages)
        state = self._privacy(self._session_id)[0]  # no record: the capture above recorded this run
        if state == "yes":
            return "This session is private: MeMesh saves nothing from it."
        if state == "unchecked":
            return "MeMesh cannot tell whether this session is private, so it saves nothing from it for now."
        return (
            "What this session did so far (files edited, errors fixed) is "
            "recorded in MeMesh — recall via memesh_recall if needed later — "
            "so the summary here can stay concise rather than exhaustive."
        )

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        # shutdown() follows ~1 ms later (Pitfall 5); drain queued turns
        # first so the session's last decisions are not the ones lost.
        self._drain_turns_before_exit()
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
        # A branched or compressed session continues the one it came from, so it
        # is private too when that one was; a /reset starts fresh and carries
        # nothing. A /resume opens an OLD session that has nothing to do with
        # the one just left: it is private only if it was marked itself (or its
        # own history holds the call, which sync_turn and capture-session read).
        # A host that sends no reason (an older Hermes) cannot be told apart from a resume: the parents are recorded
        # as a guess, so while one of them is private the new session saves nothing and every capture records why,
        # in this instance and after a restart alike, but it is never given a private marker of its own.
        reason = kwargs.get("reason")
        parents = [p for p in (parent_session_id, self._session_id) if p]
        if not reset and reason != "resume" and parents:
            self._add_parents(new_session_id, parents, guess=reason is None)
            if any(self._privacy(p)[0] == "yes" for p in parents):
                if reason is None:
                    _record_outcome("error", _MARKER_NO_REASON)
                else:
                    self._mark_private(new_session_id)
        self._session_id = new_session_id
        # A new session's exit gets its own drain budget.
        self._drain_deadline = None
        self._drain_warned = False
        if reset:
            with self._prefetch_lock:
                self._prefetch_query = None
                self._prefetch_result = None

    # -- explicit tools -----------------------------------------------------

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [
            {
                "name": "memesh_remember",
                "description": "Store a fact, decision, preference, pattern, or lesson in persistent memory. Saving is on by default: store without waiting to be asked; the only exception is the user explicitly asking not to save.",
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
                            "description": "For a decision: why it was made and what would make it stop holding (required to create a decision, architecture_decision or design_decision)",
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
                "name": "memesh_private_session",
                "description": "Call this when the user explicitly asks not to remember or save this session or conversation, in any words or language (for example \"don't keep any of this\", \"off the record\", 「這段不要記」; these illustrate, they are not a list to match). A remark whose meaning is not clearly that is not a request: keep saving as usual. It writes only a small marker file under the Hermes home (the session id, no content; if that fails, an error line for `memesh doctor`, no content either): the call itself is the signal (even if its result is an error), and automatic saving stops for the rest of this session. What was saved earlier stays; memesh_forget removes it. After calling it, write nothing to memory: no `remember` or `learn`, and no writes to the host's own memory files, unless the user later asks you to store something explicitly. A request not to save one thing (a password, one detail) means simply not saving that thing; do not call this tool for it, and do not call it just because the user mentions or discusses this feature.",
                "parameters": {"type": "object", "properties": {}},
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
            elif tool_name == "memesh_private_session":
                marked = self._mark_private(self._session_id)
                message = "Automatic saving stops for this session. What was saved earlier stays; memesh_forget removes it."
                if not marked:
                    message += (
                        " The marker that keeps saving stopped after a compression or a resume could not be written,"
                        " so saving may start again then."
                    )
                return json.dumps({"success": True, "message": message, "marker_written": marked})
            else:
                raise NotImplementedError(
                    f"memesh provider does not handle tool {tool_name}"
                )
            if resp.status_code >= 400:
                # The server's own sentence says what to change (a decision
                # without `why`); a bare status line does not.
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
