"""Drive extensions/hermes-memesh's MemeshProvider through one session.

Usage: python drive_provider.py <extension_init_py> <hermes_home> <messages_json>
Prints one JSON object with what each call returned.
"""

import importlib.util
import json
import os
import sys

ext_init, hermes_home, messages_path = sys.argv[1:4]
spec = importlib.util.spec_from_file_location("memesh_hermes_ext", ext_init)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

p = mod.MemeshProvider()
out = {"available": p.is_available()}
p.initialize("contract-session", hermes_home=hermes_home, agent_context="primary")
out["provider_pid"] = os.getpid()
out["system_prompt_block"] = p.system_prompt_block()
out["tool_schemas"] = p.get_tool_schemas()
out["message_discover"] = json.loads(p.handle_tool_call("memesh_message", {"action": "discover"}))

p.sync_turn("hi", "Hello! How can I help?")
p.sync_turn("Which queue should we use?", "We decided to use BullMQ for the job queue.")
p._turn_queue.join()

out["remember"] = json.loads(p.handle_tool_call(
    "memesh_remember",
    {"name": "contract-fact", "type": "fact", "observations": ["The contract test wrote this via HTTP"]},
))
# A decision with no `why` is stored as it is; a later call adds the reason.
out["remember_bare"] = json.loads(p.handle_tool_call(
    "memesh_remember",
    {"name": "contract-choice", "type": "decision", "observations": ["Chose the plain option"]},
))
out["remember_decision"] = json.loads(p.handle_tool_call(
    "memesh_remember",
    {"name": "contract-choice", "type": "decision", "observations": ["Chose the plain option"], "why": "it is the least moving parts; revisit if it stops scaling"},
))
out["recall_tool"] = json.loads(p.handle_tool_call("memesh_recall", {"query": "contract test"}))
# A different session can retrieve the stored turn; the writer session cannot
# answer itself through automatic recall.
out["own_prefetch"] = p.prefetch("BullMQ job queue")
out["prefetch"] = p.prefetch("BullMQ job queue", session_id="reader-session")
out["repeat_prefetch"] = p.prefetch("BullMQ job queue", session_id="reader-session")
out["other_reader_prefetch"] = p.prefetch("BullMQ job queue", session_id="other-reader")

messages = json.load(open(messages_path))["messages"]
# Nothing is captured at a compression or session boundary: every turn was stored as it happened.
out["pre_compress"] = p.on_pre_compress(messages)
p.on_session_end(messages)
out["forget"] = json.loads(p.handle_tool_call("memesh_forget", {"name": "contract-fact"}))
p.on_session_switch("switched-session")
out["message_kwargs_session"] = json.loads(p.handle_tool_call("memesh_message", {"action": "discover"}, session_id="kwargs-session"))
out["message_rejected"] = json.loads(p.handle_tool_call("memesh_message", {
    "action": "send", "recipient": "unknown-conversation", "kind": "question", "body": "synthetic rejection",
}))
p.shutdown()
print(json.dumps(out))
