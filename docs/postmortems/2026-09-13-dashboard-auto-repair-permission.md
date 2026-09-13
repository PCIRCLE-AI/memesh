# Dashboard auto-repair hid permission failures

**Date:** 2026-09-13
**Affected release:** 4.9.4; reproduced against the pre-release candidate
**Surface:** Dashboard `POST /v1/doctor/fix`

## Symptom

The Dashboard kept the diagnostic warning and its **Fix automatically** button
after a repair attempt, while showing only “The server hit an unexpected
error.” Both retired-config cleanup and plugin-cache refresh could present the
same symptom.

## Root cause

The repair route classified every unexpected exception as
`server.internal`. The response retained the underlying exception text, but
the Dashboard correctly preferred the localized message for that known code.
That localization was intentionally generic, so a filesystem `EACCES`,
`EPERM`, `EROFS`, or an upgrade script that could not create its lock became
indistinguishable from an unrelated server defect.

## Why existing gates missed it

The HTTP test covered successful config repair. The component test covered a
successful button click. Neither injected a write failure through the real
route and then asserted the visible message. The browser release review also
did not include a permission-denied repair fixture.

## Gate added

The server now maps only recognized local write failures to the stable
`operation.permission-denied` code and returns fixed recovery guidance that
contains no exception, command output, username, or path. Focused regressions
cover direct filesystem codes, the owned plugin upgrade-lock message,
contention and unrelated failures, localized Dashboard rendering, raw-path
suppression, and an enabled retry button. Release browser review must inject a
denied write, observe the actionable message, restore permission, retry, and
read back the repaired state.
