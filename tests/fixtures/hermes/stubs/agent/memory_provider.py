"""Stand-in for Hermes Agent's `agent.memory_provider` module.

The contract test loads extensions/hermes-memesh without a Hermes checkout;
the provider only needs the base class to exist.
"""


class MemoryProvider:
    pass
