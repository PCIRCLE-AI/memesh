## What and why

<!-- One paragraph: the user-visible change and the reason, in the product's vocabulary. -->

Plan: `docs/plans/<slug>.md` · Spec: `docs/specs/<slug>.md` · Intent: `intent/<slug>.md`

## Verification

<!-- Paste the closing lines of `npm run verify` and the receipt tree from .verify/receipt.json. A red run goes here too, verbatim, with the failing step. -->

```
[verify N/N] <last step's label from sdlc/config.json>
[verify] ok <step id> (<seconds>s)
[verify] GREEN. Receipt for tree <hash> written to .verify/receipt.json.
```

### Proof lines from the plan

| Proof line | Result |
|---|---|
| `npm run verify` exit 0 | |

## Coverage

| Surface | QA | Review | Simplification |
|---|---|---|---|
| `path/to/file` | `command`, exit 0 | | |

## Journey verifier

<!-- Filled by the journey-verifier agent or the reviewer: which flows were walked in the running app, what was seen, anything that does not match the plan. -->
