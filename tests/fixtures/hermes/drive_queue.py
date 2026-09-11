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
print(json.dumps(out))
