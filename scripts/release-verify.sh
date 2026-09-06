#!/usr/bin/env bash
# release-verify.sh — pre-publish gate for `memesh` releases (#28)
#
# Use:
#   bash scripts/release-verify.sh                    # full pass
#   bash scripts/release-verify.sh --quick            # build + tests only (no smoke / install probe)
#
# Exit code:
#   0 — this script's checks passed; release authorization is separate
#   1 — at least one gate failed; do NOT publish
#
# This is the "verify before update" rule (per user directive,
# 2026-05-08): every npm publish must pass these gates first.
# Tests-pass alone has been insufficient — this also probes the
# end-to-end install path and runtime smoke that pure unit tests
# can't see.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

QUICK=0
for arg in "$@"; do
  case "$arg" in
    --quick)          QUICK=1 ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      echo "unknown flag: $arg" >&2
      exit 1
      ;;
  esac
done

PASSED=0
FAILED=0
FAIL_NAMES=()

run_gate() {
  local name="$1"; shift
  printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$name"
  if "$@"; then
    echo "  ✅ PASS"
    PASSED=$((PASSED + 1))
  else
    echo "  ❌ FAIL"
    FAILED=$((FAILED + 1))
    FAIL_NAMES+=("$name")
  fi
}

gate_typecheck() { npm run typecheck >/dev/null 2>&1; }
gate_build() { npm run build >/dev/null 2>&1; }

# Run a command against a throwaway HOME, with the memesh env overrides cleared.
#
# This replaced editing the maintainer's real ~/.memesh/config.json and putting
# it back with an EXIT trap — which parked the only copy of live config in a
# world-readable /tmp file, where a SIGKILL, a crash between the two writes or a
# /tmp sweep lost it. A throwaway HOME has no config to strip, so there is
# nothing to restore and nothing to lose.
#
# HOME alone is NOT isolation. `src/core/paths.ts` resolves MEMESH_DIR and
# MEMESH_DB_PATH *before* falling back to HOME, so either one exported in the
# maintainer's shell — a normal state while debugging against a copy — routes
# every gate straight back at the real config and the real database. `env -u`
# removes them for the child process only.
#
# MEMESH_DB_PATH is deliberately not re-set to a temp file either: several
# hook tests exercise the "no database yet" branches, and pointing the env var
# at an existing file makes those branches unreachable.
#
# One helper rather than one copy per gate, because the copy was the bug: the
# commit that isolated the test suite stopped one gate short, and `doctor`
# — which calls openDatabase(), and so runs schema migrations, the FTS rebuild
# and the FTS migration — kept running against the real database as a side
# effect of a *verification* script.
with_throwaway_home() {
  local throwaway_home rc
  throwaway_home="$(mktemp -d)"
  env -u MEMESH_DIR -u MEMESH_DB_PATH HOME="$throwaway_home" USERPROFILE="$throwaway_home" "$@"
  rc=$?
  rm -rf "$throwaway_home"
  return $rc
}

gate_full_test_suite() {
  # Output goes to a log, not /dev/null: this gate failed once during the
  # v4.3.0 release and left NOTHING to diagnose — a verdict without evidence.
  # On failure the tail is printed and the log path named.
  # mktemp -d, not `mktemp -t X).log`: the first form created the mktemp
  # file AND wrote to a different concatenated path, orphaning one empty
  # temp file per run — and a suffix template is GNU-only, while this runs
  # on macOS too.
  local logdir log
  logdir="$(mktemp -d)"
  log="$logdir/suite.log"
  if with_throwaway_home npx vitest run >"$log" 2>&1; then
    rm -rf "$logdir"
    return 0
  fi
  echo "  suite output tail ($log):"
  tail -20 "$log" | sed 's/^/    /'
  return 1
}

gate_doctor_runs() {
  # Isolated: `doctor` calls openDatabase(), which runs schema migrations, the
  # FTS segmentation rebuild. Unisolated, a
  # verification script mutated the maintainer's real knowledge-graph.db.
  # Measured under a throwaway HOME: overall PASS_WITH_CONCERNS with zero
  # `fail` checks (only "Hook activity" and "Update status" warn), so the
  # assertion below - no check may be `fail` - still means what it meant.
  #
  # Output goes to a private mktemp file, not a fixed world-readable /tmp
  # path that was also never deleted.
  local doctor_json rc doctor_rc
  doctor_json="$(mktemp)"
  with_throwaway_home node dist/transports/cli/cli.js doctor --json >"$doctor_json" 2>/dev/null
  doctor_rc=$?
  if [ ! -s "$doctor_json" ]; then rm -f "$doctor_json"; return 1; fi
  DOCTOR_JSON="$doctor_json" python3 - <<'PY'
import json, os
with open(os.environ['DOCTOR_JSON']) as f: d = json.load(f)
status = d.get('status', '')
checks = d.get('checks', [])
fail = [c for c in checks if c.get('status') == 'fail']
if fail:
    print('FAIL checks:')
    for c in fail:
        print(f'  - {c.get("label")}: {c.get("summary")[:120]}')
    raise SystemExit(1)
print(f'overall: {status}, checks: {len(checks)}')
PY
  rc=$?
  rm -f "$doctor_json"
  # The JSON is the verdict on the CHECKS; the exit code is the verdict on
  # the RUN. They were not the same thing and only one was read: doctor
  # printed a complete report and then died — an unflushed write, a throw in
  # a later section, a crash on close — and this gate reported PASS from the
  # part that made it to disk. `doctor` exits non-zero when a check fails, so
  # the python above already accounts for that case; a non-zero exit with no
  # failing check is the one this catches.
  if [ "$rc" -eq 0 ] && [ "$doctor_rc" -ne 0 ]; then
    echo "  doctor printed a clean report but exited $doctor_rc — the run did not finish"
    return 1
  fi
  return $rc
}

gate_install_hooks_dryrun() {
  with_throwaway_home node dist/transports/cli/cli.js install-hooks --dry-run >/dev/null 2>&1
}

gate_feedback_url_builds() {
  with_throwaway_home node dist/transports/cli/cli.js feedback --bug --no-open --no-diagnostics --message "release-verify" 2>/dev/null \
    | grep -q "github.com/PCIRCLE-AI/memesh/issues/new"
}

gate_demo_seed_idempotent() {
  local tmpdir
  tmpdir="$(mktemp -d)"
  MEMESH_DB_PATH="$tmpdir/memesh-rv-demo.db" node -e "
    Promise.all([import('./dist/core/demo.js'), import('./dist/db.js')]).then(([demo, dbMod]) => {
      const db = dbMod.openDatabase(process.env.MEMESH_DB_PATH);
      const a = demo.seedDemo(db);
      const b = demo.seedDemo(db);
      process.exit(a.inserted === 30 && b.inserted === 0 ? 0 : 1);
    });
  " 2>/dev/null
  local rc=$?
  rm -rf "$tmpdir"
  return $rc
}

echo "release-verify @ $(date)"
echo "repo: $REPO_ROOT"

run_gate "typecheck (tsc -p tsconfig.check.json)" gate_typecheck
run_gate "build (tsc + dashboard)" gate_build

if [ "$QUICK" = 0 ]; then
  run_gate "full vitest suite (throwaway HOME, no real config)" gate_full_test_suite
  run_gate "memesh doctor — overall status not FAIL" gate_doctor_runs
  run_gate "memesh install-hooks --dry-run" gate_install_hooks_dryrun
  run_gate "feedback draft URL build (no browser/submission)" gate_feedback_url_builds
  run_gate "demo seed idempotency" gate_demo_seed_idempotent
fi

echo ""
echo "─────────────────────────────────"
echo "$PASSED gate(s) passed, $FAILED failed"
if [ "$FAILED" -gt 0 ]; then
  echo "FAILED gates:"
  for n in "${FAIL_NAMES[@]}"; do echo "  - $n"; done
  echo ""
  echo "DO NOT release. Fix the gates above and re-run."
  exit 1
fi
echo "✅ This script's checks passed. Tag, release, and publish authorization is not implied."
