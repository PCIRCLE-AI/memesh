"""Drive extensions/hermes-memesh's MemeshProvider through one session.

Usage: python drive_provider.py <extension_init_py> <hermes_home> <messages_json>
Prints one JSON object with what each call returned.
"""

import importlib.util
import json
import sys

ext_init, hermes_home, messages_path = sys.argv[1:4]
spec = importlib.util.spec_from_file_location("memesh_hermes_ext", ext_init)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

p = mod.MemeshProvider()
out = {"available": p.is_available()}
p.initialize("contract-session", hermes_home=hermes_home, agent_context="primary")
out["system_prompt_block"] = p.system_prompt_block()

p.sync_turn("hi", "Hello! How can I help?")
p._sync_thread.join()
p.sync_turn("Which queue should we use?", "We decided to use BullMQ for the job queue.")
p._sync_thread.join()

out["remember"] = json.loads(p.handle_tool_call(
    "memesh_remember",
    {"name": "contract-fact", "type": "fact", "observations": ["The contract test wrote this via HTTP"]},
))
out["recall_tool"] = json.loads(p.handle_tool_call("memesh_recall", {"query": "contract test"}))
out["prefetch"] = p.prefetch("BullMQ job queue")

messages = json.load(open(messages_path))["messages"]
out["session_end"] = p._capture_session(messages)
p.on_session_end(messages)
out["forget"] = json.loads(p.handle_tool_call("memesh_forget", {"name": "contract-fact"}))
p.shutdown()
print(json.dumps(out))
