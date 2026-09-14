# Observation forget undone by Stop (#346)

- **Symptom:** Removing one observation from a session snapshot succeeded, but
  the next Stop restored it.
- **Root cause:** Stop rebuilt the files, fixes, and summary observations from
  the transcript without retaining observation-level exclusions.
- **Why existing checks missed it:** Whole-entity archive protection was covered;
  the sequence of observation removal followed by another Stop was not.
- **Fix and regression gate:** Store hashes of excluded exact observation text
  in snapshot metadata and filter replacements before rebuilding search entries.
  Explicitly remembering the text clears its exclusion. Real Stop fixtures cover
  all three snapshot kinds, repeated Stops, search, new content, and restoration.
  The read-only memory invariant flags excluded text found in stored observations.
  Import regressions also verify that append and overwrite preserve local
  exclusions against conflicting bundle metadata; untrusted writes cannot clear
  them as an explicit `remember` can.
