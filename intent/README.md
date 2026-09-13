# Intent home

Every change starts here as `intent/<slug>.md` (copy `TEMPLATE.md`; slug is
lowercase letters, digits and hyphens). `status: draft` while it is discussed;
merging it with `status: accepted` starts the loop (`.github/workflows/sdlc-loop.yml`
opens the spec PR). `status: closed` ends it without building. The monitor files
intents here too, with `origin: monitor`. See `docs/sdlc/LOOP.md`.
