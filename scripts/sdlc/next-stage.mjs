// The loop's state machine. Reads the artifact chain in the repo and says
// which artifacts are accepted but have no downstream artifact yet:
//
//   intent/<slug>.md      status: accepted  and no docs/specs/<slug>.md   -> spec
//   docs/specs/<slug>.md  status: accepted  and no docs/plans/<slug>.md   -> plan
//   docs/plans/<slug>.md  status: accepted  and no PR/MR from sdlc/<slug> -> build
//
// Every stage asks the host about its own branch: an open request means the
// stage already ran and waits on a person (not re-run); a closed, unmerged
// request is a rejected attempt (run again); for build, merged means done.
//
// Deterministic: git, files and one host query. Artifacts it cannot read
// (no frontmatter, no status, bad slug) are reported, never dropped quietly.
//
//   node scripts/sdlc/next-stage.mjs            JSON list of pending stages
//   node scripts/sdlc/next-stage.mjs --human    one line per item

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, loadConfig, readArtifact, slugFromFile } from "./lib.mjs";
import { isMain } from "./cli.mjs";
import { hostFor } from "./host.mjs";

export const CHAIN = [
  { stage: "spec", from: "intent", to: "docs/specs" },
  { stage: "plan", from: "docs/specs", to: "docs/plans" },
  { stage: "build", from: "docs/plans", to: null },
];

// Slugs become branch names and shell arguments in CI, so only this shape is
// accepted; anything else is reported, never advanced.
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,79}$/u;

function artifactsIn(dir, root) {
  const abs = path.join(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((name) => name.endsWith(".md") && !/^(README|TEMPLATE)\.md$/u.test(name))
    .map((name) => readArtifact(path.join(abs, name)));
}

// What the host knows about a stage's branch. Throws when the host cannot be
// asked; the caller must not guess.
export function requestStateOnHost(branch, { root = REPO_ROOT, config = loadConfig(root) } = {}) {
  return hostFor(config).requestState(branch, { cwd: root });
}

export const STAGE_BRANCH = {
  spec: (slug) => `sdlc/spec/${slug}`,
  plan: (slug) => `sdlc/plan/${slug}`,
  build: (slug) => `sdlc/${slug}`,
};

export function pendingStages({ root = REPO_ROOT, requestState = requestStateOnHost, logger = console } = {}) {
  const pending = [];
  for (const link of CHAIN) {
    for (const artifact of artifactsIn(link.from, root)) {
      const rel = path.relative(root, artifact.file);
      if (!("status" in artifact.data)) {
        logger.error(`sdlc: ${rel} has no \`status\` in its frontmatter (or the frontmatter is not at the top of the file); not advanced.`);
        continue;
      }
      if (artifact.data.status !== "accepted") continue;
      const slug = slugFromFile(artifact.file);
      if (!SLUG_RE.test(slug)) {
        logger.error(`sdlc: ignoring ${rel}: file name must match ${SLUG_RE} to become a branch name.`);
        continue;
      }
      // A plan records its own build in `build:` (the build stage writes
      // `pr`, a person may write `merged` or `manual`); anything but
      // `pending` means the host is not asked.
      const buildRecorded = !link.to && artifact.data.build && artifact.data.build !== "pending";
      if (link.to && existsSync(path.join(root, link.to, `${slug}.md`))) continue;
      if (buildRecorded) continue;
      // A request already open from this stage's branch means the stage ran and
      // is waiting on a person; a merged build request means the build is done.
      // A closed, unmerged request is a rejected attempt: the stage runs again.
      const state = requestState(STAGE_BRANCH[link.stage](slug), { root });
      if (state === "open") {
        logger.error(`sdlc: ${link.stage} for ${slug} already has an open request from ${STAGE_BRANCH[link.stage](slug)}; waiting on review, not re-run.`);
        continue;
      }
      if (!link.to && state === "merged") continue;
      pending.push({ stage: link.stage, slug, artifact: rel, title: artifact.data.title ?? slug, previous: state });
    }
  }
  return pending;
}

if (isMain(import.meta.url)) {
  const items = pendingStages();
  if (process.argv.includes("--human")) {
    if (items.length === 0) console.log("sdlc: nothing pending; every accepted artifact already has its next stage.");
    for (const item of items) console.log(`${item.stage}\t${item.slug}\t${item.artifact}`);
  } else {
    console.log(JSON.stringify(items));
  }
}
