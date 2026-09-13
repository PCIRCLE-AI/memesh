import assert from "node:assert/strict";
import test from "node:test";
import { render, smoke, smokeCommand } from "./smoke-public.mjs";

const SHA = "c".repeat(40);

test("smoke.command: the command's exit code is the verdict and its placeholders are filled", () => {
  const green = smokeCommand({ command: ["node", "-e", "console.log(process.argv[1], process.argv[2]); process.exit(0)", "{{SHA}}", "{{VERSION}}"], sha: SHA, version: "1.2.3" });
  assert.equal(green.ok, true);
  assert.equal(green.checks.length, 1);
  assert.match(green.checks[0].detail, new RegExp(`exit 0; ${SHA} 1\\.2\\.3`, "u"));
  assert.match(render(green), /smoke GREEN for command: node .* \(version 1\.2\.3\)/u);

  const red = smokeCommand({ command: ["node", "-e", "console.error('registry says no'); process.exit(3)"], sha: SHA });
  assert.equal(red.ok, false);
  assert.match(red.checks[0].detail, /exit 3; registry says no/u);
  assert.match(render(red), /^FAIL .*\nsmoke RED for command: /u);

  const missing = smokeCommand({ command: ["definitely-not-a-command-xyz"], sha: SHA });
  assert.equal(missing.ok, false);
  assert.match(missing.checks[0].detail, /could not run/u);
});

test("no origin and no command is an error, not a green receipt", async () => {
  await assert.rejects(() => smoke({ origin: null, sha: SHA, smokeConfig: {} }), /no smoke\.command/u);
  const viaConfig = await smoke({ origin: null, sha: SHA, version: "9.9.9", smokeConfig: { command: ["node", "-e", "process.exit(0)"] } });
  assert.equal(viaConfig.ok, true);
  assert.equal(viaConfig.version, "9.9.9");
});
