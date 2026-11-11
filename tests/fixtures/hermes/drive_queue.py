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

# memesh_private_session: the call stops capture for that session, a turn
# already waiting in the queue included, and no other session.
seen = []
pv = mod.MemeshProvider()
pv.initialize("pv-session", hermes_home=hermes_home, agent_context="primary")
pv._run_capture = lambda args, payload, timeout: seen.append(args[1])
out["private_tool_listed"] = "memesh_private_session" in [t["name"] for t in pv.get_tool_schemas()]
out["private_reply"] = json.loads(pv.handle_tool_call("memesh_private_session", {}))
pv.sync_turn("u", "We decided on option A.")
out["private_compress_text"] = pv.on_pre_compress([{"role": "user", "content": "x"}])
pv.on_session_end([{"role": "user", "content": "x"}])
pv.shutdown()
out["private_captures"] = len(seen)

seen_control = []
pc = mod.MemeshProvider()
pc.initialize("pc-session", hermes_home=hermes_home, agent_context="primary")
pc._run_capture = lambda args, payload, timeout: seen_control.append(args[1])
pc.sync_turn("u", "We decided on option A.")
pc.on_session_end([{"role": "user", "content": "x"}])
pc.shutdown()
out["control_captures"] = len(seen_control)

gate = threading.Event()
seen_queued = []
pq = mod.MemeshProvider()
pq.initialize("pq-session", hermes_home=hermes_home, agent_context="primary")
pq._run_capture = lambda args, payload, timeout: (gate.wait(10), seen_queued.append(payload["assistant"]))
pq.sync_turn("u0", "a0")
time.sleep(0.1)  # the worker holds the first turn
pq.sync_turn("u1", "a1")
pq.handle_tool_call("memesh_private_session", {})
gate.set()
pq.on_session_end([])
pq.shutdown()
out["queued_after_private"] = seen_queued

# After a restart the flag is gone, but the history the host passes with a turn
# still holds the call: sync_turn reads it and captures nothing.
history_call = [{"role": "assistant", "content": "", "tool_calls": [{"id": "h1", "type": "function", "function": {"name": "memesh_private_session", "arguments": "{}"}}]}]
history_plain = [{"role": "assistant", "content": "", "tool_calls": [{"id": "h2", "type": "function", "function": {"name": "memesh_recall", "arguments": "{}"}}]}]
restart = {}
for label, history in (("with_call", history_call), ("without_call", history_plain)):
    seen_turns = []
    pr = mod.MemeshProvider()
    pr.initialize("restart-" + label, hermes_home=hermes_home, agent_context="primary")
    pr._run_capture = lambda args, payload, timeout, seen_turns=seen_turns: seen_turns.append(args[1])
    pr.sync_turn("u", "We decided on option A.", messages=history)
    pr.sync_turn("u2", "We decided on option B.")
    pr.on_session_end([])
    pr.shutdown()
    restart[label] = seen_turns
out["restart_turns"] = restart

# The session-end capture reads the history too (a provider that never saw the call).
history_bare = [{"role": "assistant", "content": "", "tool_calls": [{"id": "h3", "type": "function", "function": {"name": "private_session", "arguments": "{}"}}]}]
session_end = {}
for label, history in (("prefixed", history_call), ("bare", history_bare), ("plain", history_plain)):
    seen_end = []
    pe = mod.MemeshProvider()
    pe.initialize("end-" + label, hermes_home=hermes_home, agent_context="primary")
    pe._run_capture = lambda args, payload, timeout, seen_end=seen_end: seen_end.append(args[1])
    pe.on_session_end(history)
    pe.shutdown()
    session_end[label] = seen_end
out["session_end_captures"] = session_end

# Records go under the test's own folder from here on (resume_legacy below records one), so it is removed with it.
import os
import tempfile
os.environ["MEMESH_DIR"] = tempfile.mkdtemp(prefix="memesh-marker-outcomes-", dir=hermes_home)
# A branched or compressed session inherits the flag in memory; a /resume of an
# old session and a /reset do not.
inherit = {}
for label, kwargs in (
    ("resume_legacy", {"parent_session_id": "src"}),            # no reason: the stricter branch
    ("branch", {"reason": "branch"}),
    ("compression", {"parent_session_id": "src", "reason": "compression"}),
    ("resume_unrelated", {"parent_session_id": "src", "reason": "resume"}),
    ("reset", {"reset": True}),
):
    seen_switch = []
    ps = mod.MemeshProvider()
    ps.initialize("src", hermes_home=hermes_home, agent_context="primary")
    ps._run_capture = lambda args, payload, timeout, seen_switch=seen_switch: seen_switch.append(args[-1])
    ps.handle_tool_call("memesh_private_session", {})
    ps.on_session_switch("next-" + label, **kwargs)
    ps.sync_turn("u", "We decided on option A.")
    ps.on_session_end([{"role": "user", "content": "x"}])
    ps.shutdown()
    inherit[label] = len(seen_switch)
out["private_after_switch"] = inherit

# Hermes ends the session and starts a NEW provider instance with the same id at
# /compress, /resume, /branch and /new, so the private mark has to survive on
# disk (a marker file under the Hermes home) and not only in memory.
import os
import stat
import tempfile

history10 = history_plain * 5 + history_call * 5   # ten messages, tool calls included
history6 = [{"role": "user", "content": f"after the summary {i}"} for i in range(6)]  # nothing about the call


def fresh(session_id, home, seen):
    provider = mod.MemeshProvider()
    provider.initialize(session_id, hermes_home=home, agent_context="primary")
    provider._run_capture = lambda args, payload, timeout: seen.append(args[1])
    return provider


def home_for(label):
    path = os.path.join(hermes_home, "marker-" + label)
    os.makedirs(path, exist_ok=True)
    return path


marker = {}
# 1. The order a real Hermes uses for /compress.
qa_home = home_for("qa")
qa_seen_a, qa_seen_b = [], []
a = fresh("qa-session", qa_home, qa_seen_a)
a.handle_tool_call("memesh_private_session", {})
a.on_pre_compress(history10)
a.on_session_end(history10)
a.shutdown()
b = fresh("qa-session", qa_home, qa_seen_b)   # a new instance, the same id, an empty memory
b.sync_turn("u", "We decided on option A.", messages=history6)
b.on_session_end(history6)
b.shutdown()
marker["init_knows_private"] = fresh("qa-session", qa_home, [])._privacy("qa-session")[0] == "yes"
marker_file = os.path.join(qa_home, "memesh-private-sessions", "qa-session")
marker["compress_new_instance_captures"] = qa_seen_a + qa_seen_b
try:
    marker["file_mode"] = stat.S_IMODE(os.stat(marker_file).st_mode)
    marker["file_content"] = open(marker_file).read()
except OSError as exc:  # noqa: BLE001  (a missing marker must show as a failed assertion, not stop the driver)
    marker["file_mode"] = None
    marker["file_content"] = f"{type(exc).__name__}"

# 1b. A marker written by another instance after this one initialised is still honoured.
late_home = home_for("late")
late_seen = []
n = fresh("late-session", late_home, late_seen)
o = fresh("late-session", late_home, [])
o.handle_tool_call("memesh_private_session", {})
n.sync_turn("u", "We decided on option J.", messages=history6)
n.on_session_end(history6)
marker["late_marker_captures"] = late_seen

# 2. /branch, then /compress: the branch learns it is private from its history, and writes its own marker.
br_home = home_for("branch")
br_seen = []
c = fresh("branch-child", br_home, br_seen)
c.sync_turn("u", "We decided on option B.", messages=history_call)
c.shutdown()
d = fresh("branch-child", br_home, br_seen)
d.sync_turn("u", "We decided on option C.", messages=history6)
d.on_session_end(history6)
d.shutdown()
marker["branch_then_compress_captures"] = br_seen

# 3. /resume of an unrelated old session is not made private; /resume of one that was private stays private.
rs_home = home_for("resume")
rs_seen_old, rs_seen_private = [], []
e = fresh("was-private", rs_home, [])
e.handle_tool_call("memesh_private_session", {})
e.shutdown()
f = fresh("current-session", rs_home, rs_seen_old)
f.on_session_switch("unrelated-old", parent_session_id="was-private", reason="resume")
f.sync_turn("u", "We decided on option D.")
f.on_session_end([{"role": "user", "content": "x"}])
f.shutdown()
g = fresh("was-private", rs_home, rs_seen_private)
g.sync_turn("u", "We decided on option E.", messages=history6)
g.on_session_end(history6)
g.shutdown()
marker["resume_unrelated_captures"] = len(rs_seen_old)
marker["resume_private_captures"] = len(rs_seen_private)

# 4. A branch or compression switch writes the new id's marker; a resume switch does not.
sw_home = home_for("switch")
sw_seen_a, sw_seen_b = [], []
h = fresh("sw-a", sw_home, [])
h.handle_tool_call("memesh_private_session", {})
h.on_session_switch("sw-compressed", parent_session_id="sw-a", reason="compression")
h.on_session_switch("sw-resumed", parent_session_id="sw-a", reason="resume")
h.shutdown()
i = fresh("sw-compressed", sw_home, sw_seen_a)
i.sync_turn("u", "We decided on option F.", messages=history6)
i.shutdown()
j = fresh("sw-resumed", sw_home, sw_seen_b)
j.sync_turn("u", "We decided on option G.", messages=history6)
j.on_session_end(history6)
j.shutdown()
marker["compressed_child_captures"] = len(sw_seen_a)
marker["resumed_target_captures"] = len(sw_seen_b)

outcomes_file = os.path.join(os.environ["MEMESH_DIR"], "hook-outcomes.jsonl")


def outcome_lines():
    return open(outcomes_file).read().splitlines() if os.path.exists(outcomes_file) else []


def recorded_since(count):
    """The records written after the first `count`, so each scenario answers for itself."""
    return outcome_lines()[count:]


# 5. The marker cannot be written (its folder is read-only; reading it works): the reply says so, saving still
# stops in this process, and an error is recorded. Memory alone keeps the session private here.
wf_home = home_for("writefail")
os.makedirs(os.path.join(wf_home, "memesh-private-sessions"), mode=0o500, exist_ok=True)
os.chmod(os.path.join(wf_home, "memesh-private-sessions"), 0o500)
wf_seen = []
before = len(outcome_lines())
k = fresh("wf-session", wf_home, wf_seen)
reply = json.loads(k.handle_tool_call("memesh_private_session", {}))
k.sync_turn("u", "We decided on option H.", messages=history6)
k.on_session_end(history6)
k.shutdown()
os.chmod(os.path.join(wf_home, "memesh-private-sessions"), 0o700)
marker["write_failure_reply"] = reply
marker["write_failure_captures"] = wf_seen
marker["write_failure_records"] = recorded_since(before)

# 6. The marker cannot be read: the session counts as private, and an error is recorded.
rf_home = home_for("readfail")
rf_seen = []
l = fresh("rf-session", rf_home, [])
l.handle_tool_call("memesh_private_session", {})
l.shutdown()
marker_dir = os.path.join(rf_home, "memesh-private-sessions")
os.chmod(marker_dir, 0)
before = len(outcome_lines())
try:
    m = fresh("rf-session", rf_home, rf_seen)
    m.sync_turn("u", "We decided on option I.", messages=history6)
    m.on_session_end(history6)
    m.shutdown()
finally:
    os.chmod(marker_dir, 0o700)
marker["read_failure_captures"] = rf_seen
marker["read_failure_records"] = recorded_since(before)

# 7. A turn already waiting in the queue is skipped when ANOTHER instance marks the session private on disk
# after it was queued (the worker looks at the disk, not only at its own memory).
wk_home = home_for("worker")
wk_seen = []
gate = threading.Event()
first_started = threading.Event()


def wk_capture(args, payload, timeout):
    wk_seen.append(payload["user"])
    first_started.set()
    gate.wait(10)


wk = mod.MemeshProvider()
wk.initialize("wk-session", hermes_home=wk_home, agent_context="primary")
wk._run_capture = wk_capture
wk.sync_turn("turn-one", "a")
first_started.wait(10)
wk.sync_turn("turn-two", "b")            # waits behind the first
other = fresh("wk-session", wk_home, [])
other.handle_tool_call("memesh_private_session", {})   # marked on disk by another instance
gate.set()
wk._turn_queue.join()
wk.shutdown()
marker["queued_turn_after_disk_mark"] = wk_seen

# 8. The history of a session that is ending shows the call: the marker is written, so the NEXT instance of that
# session does not save either (compression-only history, no tool call in it).
hm_home = home_for("history")
hm_seen = []
hm = fresh("hm-session", hm_home, [])
hm.on_pre_compress(history_call)
hm.shutdown()
hn = fresh("hm-session", hm_home, hm_seen)
hn.sync_turn("u", "We decided on option K.", messages=history6)
hn.on_session_end(history6)
hn.shutdown()
marker["history_derived_then_new_instance"] = hm_seen

# 9. A parent marked only on disk (this instance never saw the call): a branch of it is private, and writes its own marker.
pd_home = home_for("parentdisk")
pd_seen = []
pa = fresh("pd-parent", pd_home, [])
pa.handle_tool_call("memesh_private_session", {})
pa.shutdown()
pb = fresh("pd-other", pd_home, [])
pb.on_session_switch("pd-child", parent_session_id="pd-parent", reason="compression")
pb.shutdown()
pc = fresh("pd-child", pd_home, pd_seen)
pc.sync_turn("u", "We decided on option L.", messages=history6)
pc.on_session_end(history6)
pc.shutdown()
marker["parent_only_on_disk_child_captures"] = pd_seen

# 10. The marker is a dangling symlink: the link itself is the marker, so the session is private; and a marker
# that is a symlink is never written through.
sl_home = home_for("symlink")
os.makedirs(os.path.join(sl_home, "memesh-private-sessions"), mode=0o700, exist_ok=True)
os.symlink(os.path.join(sl_home, "nowhere"), os.path.join(sl_home, "memesh-private-sessions", "sl-dangling"))
sl_seen = []
sa = fresh("sl-dangling", sl_home, sl_seen)
sa.sync_turn("u", "We decided on option M.", messages=history6)
sa.on_session_end(history6)
sa.shutdown()
marker["dangling_marker_captures"] = sl_seen
elsewhere = os.path.join(sl_home, "elsewhere")
os.symlink(elsewhere, os.path.join(sl_home, "memesh-private-sessions", "sl-write"))
sb = fresh("sl-write", sl_home, [])
sb_reply = json.loads(sb.handle_tool_call("memesh_private_session", {}))
sb.shutdown()
marker["symlink_write_reply"] = sb_reply
marker["symlink_written_through"] = os.path.exists(elsewhere)

# 11. No Hermes home: whether a marker exists cannot be told, so the session counts as private, once, with an error.
nh_seen = []
before = len(outcome_lines())
nh = mod.MemeshProvider()
nh.initialize("nh-session", agent_context="primary")
nh._run_capture = lambda args, payload, timeout: nh_seen.append(args[1])
nh.sync_turn("u", "We decided on option N.", messages=history6)
nh.on_session_end(history6)
nh.shutdown()
marker["no_home_captures"] = nh_seen
marker["no_home_records"] = recorded_since(before)

# 12. A session switch with no reason (an older Hermes) from a private session: a resume cannot be told from a
# branch, so for the rest of this instance the new session saves nothing and every capture records why; no marker
# is written, so a new instance of it decides again and saves normally (Lead ruling on Q6_13 F3).
nr_home = home_for("noreason")
nr_seen_same, nr_seen_next = [], []
na = fresh("nr-parent", nr_home, nr_seen_same)
na.handle_tool_call("memesh_private_session", {})
before = len(outcome_lines())
na.on_session_switch("nr-child", parent_session_id="nr-parent")
na.sync_turn("u", "We decided on option O.", messages=history6)
na.on_session_end(history6)
na.shutdown()
marker["no_reason_switch_captures"] = nr_seen_same
marker["no_reason_switch_records"] = recorded_since(before)
marker["no_reason_switch_marker"] = os.path.lexists(mod._marker_path(nr_home, "nr-child"))
nb = fresh("nr-child", nr_home, nr_seen_next)
nb.sync_turn("u", "We decided on option O2.", messages=history6)
nb.on_session_end(history6)
nb.shutdown()
marker["no_reason_switch_next_instance_captures"] = nr_seen_next

# 13. A relative MEMESH_DB_PATH: the record is written beside it, not lost.
rel_dir = tempfile.mkdtemp(prefix="relative-db-", dir=hermes_home)
saved_cwd = os.getcwd()
saved_db_path = os.environ.get("MEMESH_DB_PATH")
os.chdir(rel_dir)
os.environ["MEMESH_DB_PATH"] = "kg.db"
try:
    rp = mod.MemeshProvider()
    rp.initialize("rel-session", agent_context="primary")
    rp._run_capture = lambda *a, **k: None
    rp.handle_tool_call("memesh_private_session", {})
    marker["relative_db_record_written"] = os.path.exists(os.path.join(rel_dir, "hook-outcomes.jsonl"))
finally:
    os.chdir(saved_cwd)
    os.environ.pop("MEMESH_DB_PATH", None)
    if saved_db_path is not None:
        os.environ["MEMESH_DB_PATH"] = saved_db_path

# 14. Session ids that are not plain tokens become hashed file names inside the marker folder, and never leave it.
us_home = home_for("unsafe")
unsafe = ["../x", "a/b", ".hidden", "..", "ok-id_1.2", "with:colon"]
for sid in unsafe:
    up = fresh(sid, us_home, [])
    up.handle_tool_call("memesh_private_session", {})
    up.shutdown()
marker["unsafe_id_files"] = sorted(os.listdir(os.path.join(us_home, "memesh-private-sessions")))
marker["unsafe_id_escaped"] = sorted(n for n in os.listdir(us_home) if n != "memesh-private-sessions")

# S3 redesign. 15. An empty session id cannot be told apart: nothing is saved, and an error says so (Q6_12 F2).
ei_home = home_for("emptyid")
ei_seen = []
before = len(outcome_lines())
ei = fresh("", ei_home, ei_seen)
ei.sync_turn("u", "We decided on option E.", messages=history6)
ei.on_session_end(history6)
ei.shutdown()
marker["empty_id_captures"] = ei_seen
marker["empty_id_records"] = recorded_since(before)

# 16. A marker folder that cannot be read at one turn and can at the next, with no marker: the second turn is saved
# (unchecked is never remembered as private, H10).
uc_home = home_for("unchecked-then-ok")
uc_seen = []
uc_dir = os.path.join(uc_home, "memesh-private-sessions")
os.makedirs(uc_dir, exist_ok=True)
uc = fresh("uc-session", uc_home, uc_seen)
os.chmod(uc_dir, 0)
try:
    uc.sync_turn("u", "We decided on option U1.", messages=history6)
finally:
    os.chmod(uc_dir, 0o700)
uc.sync_turn("u", "We decided on option U2.", messages=history6)
uc._drain_turns_before_exit()
uc.shutdown()
marker["unchecked_then_ok_captures"] = uc_seen

# 17. A compression switch with a reason records no "no reason" error (H8).
cr_home = home_for("compress-reason")
before = len(outcome_lines())
cr = fresh("cr-parent", cr_home, [])
cr.handle_tool_call("memesh_private_session", {})
cr.on_session_switch("cr-child", parent_session_id="cr-parent", reason="compression")
cr.shutdown()
marker["compress_reason_records"] = recorded_since(before)

# 18. A healthy session records that it was checked, once per instance: that is what clears an old error in doctor.
hs_home = home_for("healthy")
before = len(outcome_lines())
hs = fresh("hs-session", hs_home, [])
hs.sync_turn("u", "We decided on option H1.", messages=history6)
hs.sync_turn("u", "We decided on option H2.", messages=history6)
hs._drain_turns_before_exit()
hs.shutdown()
marker["healthy_records"] = recorded_since(before)

# 18b. One instance that checks two ordinary sessions records each once (the record is per session, not per instance).
ms_home = home_for("healthy-two")
before = len(outcome_lines())
ms = fresh("ms-one", ms_home, [])
ms.sync_turn("u", "We decided on option M1.", messages=history6)
ms.on_session_switch("ms-two", parent_session_id="ms-one", reason="resume")
ms.sync_turn("u", "We decided on option M2.", messages=history6)
ms.sync_turn("u", "We decided on option M3.", messages=history6)
ms._drain_turns_before_exit()
ms.shutdown()
marker["healthy_two_sessions_records"] = recorded_since(before)

# 18c. Every capture a private session stops records the skip: two turns, a compression and the session end.
ps_home = home_for("skips")
ps_seen = []
psk = fresh("ps-session", ps_home, ps_seen)
psk.handle_tool_call("memesh_private_session", {})
before = len(outcome_lines())
psk.sync_turn("u", "We decided on option S1.", messages=history6)
psk.sync_turn("u", "We decided on option S2.", messages=history6)
psk.on_pre_compress(history6)
psk.on_session_end(history6)
psk.shutdown()
marker["private_skip_captures"] = ps_seen
marker["private_skip_records"] = recorded_since(before)

# 19. A marker no capture touched for 30 days is removed when an instance starts; a fresh one stays.
pm_home = home_for("prune")
pm_dir = os.path.join(pm_home, "memesh-private-sessions")
os.makedirs(pm_dir, exist_ok=True)
for name, age in (("old-session", 31 * 24 * 3600), ("new-session", 60)):
    path_ = os.path.join(pm_dir, name)
    open(path_, "w").write(name)
    t = time.time() - age
    os.utime(path_, (t, t))
fresh("pm-other", pm_home, []).shutdown()
marker["prune_left"] = sorted(os.listdir(pm_dir))

# 20. The case table both deciders run (tests/fixtures/private-state-cases.json), through _privacy.
cases = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "private-state-cases.json")))
case_results = []
for i, case in enumerate(c for c in cases if c.get("kind") != "record-dir"):
    ct_home = home_for(f"case-{i}")
    if case["marker"] == "file":
        os.makedirs(os.path.join(ct_home, "memesh-private-sessions"), exist_ok=True)
        open(mod._marker_path(ct_home, case["sessionId"]), "w").write(case["sessionId"])
    if case["marker"] == "folder-is-file":
        open(os.path.join(ct_home, "memesh-private-sessions"), "w").write("x")
    cp = mod.MemeshProvider()
    cp.initialize(case["sessionId"], hermes_home=ct_home, agent_context="primary")
    state, reason = cp._privacy(case["sessionId"], case.get("messages"))
    cp.shutdown()
    case_results.append({"name": case["name"], "state": state, "expect": case["expect"]})
marker["case_table"] = case_results
record_dirs = []
for case in (c for c in cases if c.get("kind") == "record-dir"):
    saved = {k: os.environ.get(k) for k in ("MEMESH_DB_PATH", *case["env"].keys())}
    os.environ.pop("MEMESH_DB_PATH", None)
    os.environ.update(case["env"])
    try:
        got = mod._outcomes_dir()
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    record_dirs.append({"name": case["name"], "home": got == os.path.join(os.path.expanduser("~"), ".memesh")})
marker["record_dir_cases"] = record_dirs

marker["records"] = outcome_lines()
out["marker"] = marker

# shutdown() before initialize() must not raise (the old one never did).
try:
    mod.MemeshProvider().shutdown()
    out["shutdown_before_initialize"] = "ok"
except Exception as exc:  # noqa: BLE001
    out["shutdown_before_initialize"] = f"{type(exc).__name__}: {exc}"
print(json.dumps(out))
