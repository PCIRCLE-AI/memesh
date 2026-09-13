#!/usr/bin/env bash
# One-time setup for the SDLC loop: the steps only a person can do, one at a
# time, with a check after each. Secrets are typed into `gh secret set`
# directly; they never appear in a file, an argument, or an agent transcript.
set -euo pipefail

repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
echo "SDLC loop bootstrap for $repo"
echo

step() { printf '\n== %s ==\n' "$1"; }
ask() { local a; read -r -p "$1 [y/N] " a; [[ "${a:-N}" =~ ^[Yy]$ ]]; }
have_secret() { gh secret list | awk '{print $1}' | grep -qx "$1"; }

provider="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("sdlc/config.json","utf8")).agent?.provider ?? "claude")')"
step "1/5 Model credential for provider '$provider' (sdlc/config.json agent.provider)"
case "$provider" in
  claude) options="oauth api"; cat <<'EOF'
The CI-run stages (spec, plan, build, review, diagnose, evals) run `claude -p`
on a runner and need ONE of these repository secrets:
  oauth) CLAUDE_CODE_OAUTH_TOKEN  Pro/Max subscription. Run `claude setup-token`
                                  on this machine and paste the token it prints.
  api)   ANTHROPIC_API_KEY        API billing per token, from console.anthropic.com.
EOF
  ;;
  codex) options="api auth"; cat <<'EOF'
The CI-run stages run `codex exec` on a runner and need ONE of these secrets:
  api)  OPENAI_API_KEY   API billing, from platform.openai.com.
  auth) CODEX_AUTH_JSON  ChatGPT subscription: the whole contents of ~/.codex/auth.json
                         after `codex login` on this machine (this script pastes it for
                         you). Treat it as a password; re-run this step when a run reports
                         the login expired.
EOF
  ;;
  gemini) options="api"; cat <<'EOF'
The CI-run stages run `gemini -p` on a runner (UNTESTED provider) and need:
  api)  GEMINI_API_KEY   from Google AI Studio.
EOF
  ;;
  *) echo "unknown provider $provider"; exit 1;;
esac
echo "Local work (hooks, the verify command, receipts) needs none of these."
secret_for() { case "$provider:$1" in claude:oauth) echo CLAUDE_CODE_OAUTH_TOKEN;; claude:api) echo ANTHROPIC_API_KEY;; codex:api) echo OPENAI_API_KEY;; codex:auth) echo CODEX_AUTH_JSON;; gemini:api) echo GEMINI_API_KEY;; *) echo "";; esac; }
set_secret() {
  local name; name="$(secret_for "$1")"; [ -n "$name" ] || { echo "skipped"; return; }
  if [ "$name" = CODEX_AUTH_JSON ]; then
    [ -f "$HOME/.codex/auth.json" ] || { echo "~/.codex/auth.json not found: run 'codex login' first"; return; }
    gh secret set CODEX_AUTH_JSON < "$HOME/.codex/auth.json" && echo "set CODEX_AUTH_JSON from ~/.codex/auth.json"
  else
    gh secret set "$name"
  fi
}
present=""; for o in $options; do have_secret "$(secret_for "$o")" && present="$present $(secret_for "$o")"; done
if [ -n "$present" ]; then
  echo "present:$present"
  ask "Rotate or add one now?" && { read -r -p "Which? [$options] " which; set_secret "$which"; }
else
  echo "missing. gh will prompt for the value; nothing is echoed."
  read -r -p "Set which? [$options/skip] " which
  set_secret "$which"
fi
present=""; for o in $options; do have_secret "$(secret_for "$o")" && present="$present $(secret_for "$o")"; done
[ -n "$present" ] && echo "check: a model credential is present ($present )" || echo "check: STILL MISSING"

step "2/5 SDLC_GITHUB_TOKEN repository secret (fine-grained PAT)"
cat <<'EOF'
Why: pull requests and pushes made with the workflow's own GITHUB_TOKEN do not
trigger other workflows, so a PR the loop opens would never get CI and could
never satisfy branch protection. The loop pushes and opens PRs with this token
instead.
Create it at https://github.com/settings/personal-access-tokens/new
  Repository access: only this repository
  Permissions: Contents (read and write), Pull requests (read and write),
               Issues (read and write), Workflows (read and write)
  Expiration: what your policy allows; rotate through this script.
EOF
if have_secret SDLC_GITHUB_TOKEN; then
  echo "present."
  ask "Rotate it now?" && gh secret set SDLC_GITHUB_TOKEN
else
  ask "Set it now?" && gh secret set SDLC_GITHUB_TOKEN
fi
have_secret SDLC_GITHUB_TOKEN && echo "check: present" || echo "check: STILL MISSING"

step "3/5 Branch protection on main (CI required, no direct pushes, admins included; approvals per the token's owner)"
cat <<'EOF'
Accepting a request is a person's act. The loop pushes and opens requests with
SDLC_GITHUB_TOKEN, and GitHub has no scope that allows opening a PR but not
merging it, so what stops the loop from merging is branch protection:
  - token owned by a separate machine account: require 1 approval and a code
    owner review; the maintainer approves, the machine cannot.
  - token owned by the maintainer (a one-person repository): the maintainer
    cannot approve their own PR, so approvals stay at 0. Then the guard is the
    build stage's tool allowlist (claude) plus run-stage's merged-request
    check, which fails the stage after the fact. Weaker; said here so it is
    chosen knowingly.
EOF
machine=false; ask "Is SDLC_GITHUB_TOKEN owned by a separate machine account (not the maintainer)?" && machine=true
if [ "$machine" = true ]; then approvals=1; owners=true; else approvals=0; owners=false; echo "WARNING: 0 approvals; the loop's token can merge. See above."; fi
contexts="$(node -e 'const c=JSON.parse(require("fs").readFileSync("sdlc/config.json","utf8")).ci?.requiredChecks; console.log(JSON.stringify(Array.isArray(c)&&c.length?c:["FILL: exact names of the required CI check jobs (sdlc/config.json ci.requiredChecks)"]))')"
if gh api "repos/$repo/branches/main/protection" >/dev/null 2>&1; then
  echo "present:"; gh api "repos/$repo/branches/main/protection" -q '{checks: .required_status_checks.contexts, reviews: .required_pull_request_reviews.required_approving_review_count, admins: .enforce_admins.enabled}'
else
  echo "missing. This is what makes 'agents act up to the gate and not past it' a property of the repo."
  if ask "Apply now (requires admin on the repo)?"; then
    gh api -X PUT "repos/$repo/branches/main/protection" --input - <<JSON
{
  "required_status_checks": { "strict": true, "contexts": $contexts },
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": $approvals, "require_code_owner_reviews": $owners, "dismiss_stale_reviews": true },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
    echo "check:"; gh api "repos/$repo/branches/main/protection" -q '{checks: .required_status_checks.contexts, reviews: .required_pull_request_reviews.required_approving_review_count, admins: .enforce_admins.enabled}'
  fi
fi

step "4/5 Labels the loop uses"
for pair in "sdlc:spec|Spec generated by the loop; merge with status accepted to start the plan|0f6e74" \
            "sdlc:plan|Plan generated by the loop; merge with status accepted to start the build|0f6e74" \
            "sdlc:build|Implementation opened by the loop; review per REVIEW.md|a15c0a" \
            "sdlc:intent|Intent filed by the monitor; triage it|a15c0a" \
            "sdlc:release|Post-deploy release receipt|2f6b3a" \
            "sdlc:breach|Control band breached; one open issue per metric|a63d40"; do
  IFS='|' read -r name desc color <<<"$pair"
  if gh label list --json name -q '.[].name' | grep -qx "$name"; then echo "have $name"; else gh label create "$name" --description "$desc" --color "$color" && echo "created $name"; fi
done

step "5/5 Try the loop without spending anything"
echo "  node scripts/sdlc/next-stage.mjs --human        # what is accepted and waiting"
echo "  node scripts/sdlc/run-stage.mjs --stage spec --slug <slug> --artifact intent/<slug>.md --dry-run"
echo "  npm run verify                                     # the definition of done (commands.verify in sdlc/config.json)"
echo
echo "Then write intent/<slug>.md from intent/TEMPLATE.md, merge it with status: accepted, and watch Actions → SDLC loop."
