import assert from "node:assert/strict";
import test from "node:test";
import { reviewNote } from "./review.mjs";

test("an empty reviewer response fails before a public review note can be produced", () => {
  for (const text of ["", " \n", null, undefined]) {
    assert.throws(() => reviewNote({ text }), /Review produced no text/u);
  }
});

test("review notes preserve findings without adding model credits", () => {
  assert.equal(reviewNote({ text: "  Finding: failed cleanup.  " }), "## SDLC review (REVIEW.md, three passes)\n\nFinding: failed cleanup.");
  assert.equal(reviewNote({ pass: "Security", dir: "scripts", text: "No findings." }), "## Review matrix: Security / scripts\n\nNo findings.");
});
