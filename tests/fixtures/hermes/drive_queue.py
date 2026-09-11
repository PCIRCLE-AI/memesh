"""Exercise MemeshProvider's turn queue and its logged skips without a server.

Usage: python drive_queue.py <extension_init_py> <hermes_home> <fake_memesh>
Prints one JSON object.
"""

import importlib.util
import json
import logging
import sys
import threading
import time

ext_init, hermes_home, fake_bin = sys.argv[1:4]
spec = importlib.util.spec_from_file_location("memesh_hermes_ext", ext_init)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

records = []


class Collect(logging.Handler):
    def emit(self, record):
        records.append((record.levelname, record.getMessage()))


mod.logger.addHandler(Collect())
mod.logger.setLevel(logging.DEBUG)
mod._resolve_memesh_bin = lambda: fake_bin
out = {}

# A capture that hangs must not block sync_turn (the Hermes main thread).
p = mod.MemeshProvider()
p.initialize("q-session", hermes_home=hermes_home, agent_context="primary")
release = threading.Event()
p._run_capture = lambda *a, **k: release.wait(10)
start = time.monotonic()
for i in range(20):
    p.sync_turn(f"u{i}", f"a{i}")
out["sync_turn_20_calls_secs"] = time.monotonic() - start
out["queue_full_warnings"] = sum(1 for lvl, msg in records if lvl == "WARNING" and "queue full" in msg)
release.set()

# Non-primary contexts skip, and say so.
records.clear()
c = mod.MemeshProvider()
c.initialize("c-session", hermes_home=hermes_home, agent_context="cron")
c.sync_turn("u", "We decided to use X.")
c.on_session_end([{"role": "user", "content": "x"}])
out["non_primary_debug"] = sum(1 for lvl, msg in records if lvl == "DEBUG" and "not the primary" in msg)

# A CLI that prints valid JSON that is not an object is refused with a warning.
records.clear()
r = mod.MemeshProvider()
r.initialize("r-session", hermes_home=hermes_home, agent_context="primary")
out["non_dict_result"] = r._run_capture(["hermes", "capture-turn", "--session", "r"], {}, 10)
out["non_dict_warnings"] = sum(1 for lvl, msg in records if lvl == "WARNING" and "not a JSON object" in msg)
# Queued turns at session end are drained, not dropped silently.
records.clear()
d = mod.MemeshProvider()
d.initialize("d-session", hermes_home=hermes_home, agent_context="primary")
done = []
d._run_capture = lambda args, payload, timeout: (time.sleep(0.3), done.append(payload["assistant"]))
for i in range(3):
    d.sync_turn(f"u{i}", f"We decided on option {i}.")
d.on_session_end([])
d.shutdown()
out["drained_captures"] = len(done)
out["drained_unfinished"] = d._turn_queue.unfinished_tasks

# A capture that outlives the bounded wait is reported, with the count.
records.clear()
mod._DRAIN_TIMEOUT_SECS = 0.5
h = mod.MemeshProvider()
h.initialize("h-session", hermes_home=hermes_home, agent_context="primary")
stuck = threading.Event()
h._run_capture = lambda *a, **k: stuck.wait(10)
for i in range(3):
    h.sync_turn(f"u{i}", f"a{i}")
time.sleep(0.1)  # let the worker pick up the first turn
start = time.monotonic()
h.on_session_end([])
h.shutdown()
out["end_plus_shutdown_secs"] = time.monotonic() - start
out["lost_warnings"] = [msg for lvl, msg in records if lvl == "WARNING" and "before shutdown" in msg]
stuck.set()

# Round 4: a turn arriving between on_session_end() and shutdown() must not
# buy a second drain budget, and a sync_turn from another thread while a drain
# is running must not break it.
mod._DRAIN_TIMEOUT_SECS = 0.5
late = mod.MemeshProvider()
late.initialize("late-session", hermes_home=hermes_home, agent_context="primary")
late._run_capture = lambda *a, **k: stuck2.wait(10)
stuck2 = threading.Event()
late.sync_turn("u0", "a0")
start = time.monotonic()
late.on_session_end([])
late.sync_turn("u1", "late")
late.shutdown()
out["late_total_drain_secs"] = time.monotonic() - start

x = mod.MemeshProvider()
x.initialize("x-session", hermes_home=hermes_home, agent_context="primary")
x._run_capture = lambda *a, **k: stuck2.wait(10)
x.sync_turn("u", "a")
drain_errors = []


def _drain():
    try:
        x._drain_turns_before_exit()
    except Exception as exc:  # noqa: BLE001
        drain_errors.append(f"{type(exc).__name__}: {exc}")


th = threading.Thread(target=_drain)
th.start()
time.sleep(0.2)
# A session switch from another thread resets the deadline mid-wait (a new
# session's exit gets a fresh budget); the running drain must not break.
x.on_session_switch("x-session-2")
th.join()
out["cross_thread_drain_errors"] = drain_errors
out["deadline_after_switch"] = x._drain_deadline
stuck2.set()

# shutdown() before initialize() must not raise (the old one never did).
try:
    mod.MemeshProvider().shutdown()
    out["shutdown_before_initialize"] = "ok"
except Exception as exc:  # noqa: BLE001
    out["shutdown_before_initialize"] = f"{type(exc).__name__}: {exc}"
print(json.dumps(out))
