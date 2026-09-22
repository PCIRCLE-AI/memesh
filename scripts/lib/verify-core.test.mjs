import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tempRepo } from "./verify-test-helpers.mjs";
import { receiptPath, receiptStatus, treeHash, writeJson } from "./verify-core.mjs";

/**
 * Whether this process can create a symlink. Windows without Developer Mode
 * or an elevated shell throws EPERM on `symlinkSync` — checked once so the
 * two symlink-dependent tests below can skip with a visible reason instead
 * of failing for something unrelated to what they check.
 */
function symlinksSupported() {
  const dir = mkdtempSync(path.join(tmpdir(), "verify-core-symlink-probe-"));
  try {
    const target = path.join(dir, "target.txt");
    writeFileSync(target, "x");
    symlinkSync(target, path.join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const symlinkSkip = symlinksSupported() ? false : "symlinkSync is not permitted on this platform/user";

// git rev-parse HEAD^{tree} directly, rather than importing headTreeHash:
// that function stays with the maintainer-local git gates (scripts/sdlc/),
// since nothing public needs it — this test only wants a known-good tree to
// compare treeHash's clean-state answer against.
function headTree(cwd) {
  return execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("tree hash: equals HEAD when clean, changes on edit, ignores .verify/, restores on revert", () => {
  const repo = tempRepo();
  try {
    const clean = treeHash(repo.dir);
    assert.equal(clean, headTree(repo.dir));
    mkdirSync(path.join(repo.dir, ".verify"), { recursive: true });
    writeFileSync(path.join(repo.dir, ".verify", "receipt.json"), "{}");
    assert.equal(treeHash(repo.dir), clean, ".verify/ is ignored by the hash");
    writeFileSync(path.join(repo.dir, "a.txt"), "two\n");
    const edited = treeHash(repo.dir);
    assert.notEqual(edited, clean);
    writeFileSync(path.join(repo.dir, "new.txt"), "x\n");
    assert.notEqual(treeHash(repo.dir), edited, "an untracked file changes the hash");
    rmSync(path.join(repo.dir, "new.txt"));
    writeFileSync(path.join(repo.dir, "a.txt"), "one\n");
    assert.equal(treeHash(repo.dir), clean);
  } finally {
    repo.cleanup();
  }
});

test("receipt status: missing, fresh for the same tree, stale after any edit", () => {
  const repo = tempRepo();
  try {
    assert.equal(receiptStatus(repo.dir).state, "missing");
    writeJson(receiptPath(repo.dir), { tree: treeHash(repo.dir), finishedAt: "2026-01-01T00:00:00Z" });
    assert.equal(receiptStatus(repo.dir).state, "fresh");
    writeFileSync(path.join(repo.dir, "a.txt"), "three\n");
    assert.equal(receiptStatus(repo.dir).state, "stale");
  } finally {
    repo.cleanup();
  }
});

// Node realpaths the module URL but leaves `process.argv[1]` as typed, so
// through any symlink (macOS's /var -> /private/var, a symlinked workspace, a
// Windows junction) an unresolved comparison misses: `main()` never runs and
// the script exits 0. Verified by `isMain` itself against a disposable
// fixture, and end to end by spawning `scripts/verify-receipt.mjs` through a
// real symlink.
test("isMain: true run directly, true through a symlink, false when merely imported", { skip: symlinkSkip }, () => {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), "is-main-fixture-"));
  const symlinkParent = mkdtempSync(path.join(tmpdir(), "is-main-symlink-"));
  try {
    // A tiny script that imports the REAL verify-core.mjs by absolute path
    // and prints what isMain(import.meta.url) decides for itself.
    const verifyCoreAbs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "verify-core.mjs");
    writeFileSync(
      path.join(fixtureDir, "probe.mjs"),
      `import { isMain } from ${JSON.stringify(verifyCoreAbs)};\nconsole.log(isMain(import.meta.url));\n`,
    );
    // Imports probe.mjs rather than running it: when THIS file is the
    // entry point, probe.mjs's own isMain(import.meta.url) must read false
    // — argv[1] is importer.mjs, not probe.mjs.
    writeFileSync(path.join(fixtureDir, "importer.mjs"), "import './probe.mjs';\n");

    const direct = execFileSync(process.execPath, [path.join(fixtureDir, "probe.mjs")], { encoding: "utf8" }).trim();
    assert.equal(direct, "true", "direct invocation must be main");

    const symlinkPath = path.join(symlinkParent, "fixture-link");
    symlinkSync(fixtureDir, symlinkPath);
    const probeThroughSymlink = path.join(symlinkPath, "probe.mjs");
    // Precondition: the symlinked path's resolved realpath genuinely
    // differs from the path as typed — the exact divergence
    // `import.meta.url` (realpath) vs `process.argv[1]` (as typed) hits. A
    // platform/mktemp quirk that happened not to produce a real symlink
    // would otherwise make the assertion below pass for the wrong reason.
    assert.notEqual(realpathSync(probeThroughSymlink), path.resolve(probeThroughSymlink));
    const throughSymlink = execFileSync(process.execPath, [probeThroughSymlink], { encoding: "utf8" }).trim();
    assert.equal(throughSymlink, "true", "an invocation reached through a symlink must still be main");

    const imported = execFileSync(process.execPath, [path.join(fixtureDir, "importer.mjs")], { encoding: "utf8" }).trim();
    assert.equal(imported, "false", "a module merely imported by another entry point must not be main — this is why the guard exists at all");
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(symlinkParent, { recursive: true, force: true });
  }
});

// Under `node -e` there is no entry-point file: argv[1] is whatever the
// caller passed first. A caller that passes a module's path in order to
// import it must not start that module's main().
test("isMain: false for a module imported from `node -e` that received its path as an argument", () => {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), "is-main-eval-"));
  try {
    const verifyCoreAbs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "verify-core.mjs");
    const probe = path.join(fixtureDir, "probe.mjs");
    writeFileSync(
      probe,
      `import { isMain } from ${JSON.stringify(pathToFileURL(verifyCoreAbs).href)};\nconsole.log(isMain(import.meta.url));\n`,
    );
    // Control: the same file run directly IS main, so "false" below is the
    // eval rule answering, not a probe that can only ever print false.
    assert.equal(execFileSync(process.execPath, [probe], { encoding: "utf8" }).trim(), "true");

    const importIt = "import(require('node:url').pathToFileURL(process.argv[1]).href)";
    for (const flag of ["-e", "--eval"]) {
      const out = execFileSync(process.execPath, [flag, importIt, probe], { encoding: "utf8" }).trim();
      assert.equal(out, "false", `${flag}: argv[1] names the module, but nothing ran it as the entry point`);
    }
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

// `node - < file`: the entry script is read from stdin, so `argv[1]` is the
// literal string `-`, not a path. Realpathing it would throw ENOENT for a
// module that was merely imported, so it reads false, like the eval flags.
test("isMain: false, not thrown, for a module imported while the process itself was started via `node -` (stdin)", () => {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), "is-main-stdin-"));
  try {
    const verifyCoreAbs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "verify-core.mjs");
    const probe = path.join(fixtureDir, "probe.mjs");
    writeFileSync(
      probe,
      `import { isMain } from ${JSON.stringify(pathToFileURL(verifyCoreAbs).href)};\nconsole.log(isMain(import.meta.url));\n`,
    );
    const stdinScript = `import ${JSON.stringify(pathToFileURL(probe).href)};\n`;
    const out = execFileSync(process.execPath, ["--input-type=module", "-"], {
      input: stdinScript,
      encoding: "utf8",
    }).trim();
    assert.equal(out, "false", "argv[1] is the literal '-' sentinel under `node -`; there is no entry-point file for probe.mjs to be");
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

// `node <directory>` loads that directory's package.json `main`, but
// `process.argv[1]` stays the DIRECTORY path — `isMain`'s two comparisons
// both miss (it resolves to a directory, never a file), so without the
// directory branch this falls through to `return false`: a gate guarded by
// `if (isMain(...))` would silently skip its own main() and exit 0.
test("isMain: throws (not false) when argv[1] resolves to a directory — `node <dir>` loading its package.json main", () => {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), "is-main-dir-"));
  try {
    const verifyCoreAbs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "verify-core.mjs");
    writeFileSync(path.join(fixtureDir, "package.json"), JSON.stringify({ type: "module", main: "index.mjs" }));
    writeFileSync(
      path.join(fixtureDir, "index.mjs"),
      `import { isMain } from ${JSON.stringify(pathToFileURL(verifyCoreAbs).href)};\nconsole.log(isMain(import.meta.url));\n`,
    );
    const result = spawnSync(process.execPath, [fixtureDir], { encoding: "utf8" });
    assert.notEqual(result.status, 0, "node <dir> loading package.json main must not exit 0 having silently answered false");
    assert.match(result.stderr, /resolves to a directory/, "the thrown error must name what argv[1] actually resolved to");
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

// A realpath failure must throw, not answer "not the entry point". The entry
// file deletes itself, then imports a module that asks `isMain`: the typed
// path (the vanished entry) differs from that module's own, so `isMain` has
// to realpath it, and cannot.
test("isMain: a realpath failure throws instead of answering false", () => {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), "is-main-vanished-"));
  try {
    const verifyCoreAbs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "verify-core.mjs");
    writeFileSync(
      path.join(fixtureDir, "probe.mjs"),
      `import { isMain } from ${JSON.stringify(pathToFileURL(verifyCoreAbs).href)};\nconsole.log(isMain(import.meta.url));\n`,
    );
    writeFileSync(
      path.join(fixtureDir, "entry.mjs"),
      'import { unlinkSync } from "node:fs";\nimport { fileURLToPath } from "node:url";\n' +
        'unlinkSync(fileURLToPath(import.meta.url));\nawait import("./probe.mjs");\n',
    );
    const result = spawnSync(process.execPath, [path.join(fixtureDir, "entry.mjs")], { encoding: "utf8" });
    assert.notEqual(result.status, 0, "a vanished entry file must not read as \"not the entry point\"");
    assert.match(result.stderr, /ENOENT/);
    assert.equal(result.stdout.trim(), "", "isMain must not have printed an answer");
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("end to end: scripts/verify-receipt.mjs through a symlinked scripts/ directory still reports a real status", { skip: symlinkSkip }, () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const symlinkParent = mkdtempSync(path.join(tmpdir(), "verify-receipt-symlink-"));
  try {
    const scriptsLink = path.join(symlinkParent, "scripts-link");
    symlinkSync(path.join(repoRoot, "scripts"), scriptsLink);
    const entry = path.join(scriptsLink, "verify-receipt.mjs");
    assert.notEqual(realpathSync(entry), path.resolve(entry), "precondition: the symlink genuinely diverges");

    // Read-only and cheap: verify-receipt.mjs only hashes the tree and
    // reads the receipt. A guard that missed would exit 0 with EMPTY stdout
    // (`main()` never ran); a working one prints one of the three status
    // words whatever state this working tree is in.
    const result = spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 30_000 });
    assert.match(
      result.stdout,
      /fresh|stale|missing/,
      `expected a real status word; got status=${result.status} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
    );
  } finally {
    rmSync(symlinkParent, { recursive: true, force: true });
  }
});
