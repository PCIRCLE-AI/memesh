// The one place that knows whether this repo lives on GitHub (`gh`) or
// GitLab (`glab`). Every stage that opens, reads, comments on or looks up a
// pull/merge request goes through here, so a repo switches host by changing `host` in
// sdlc/config.json.

import { execFileSync } from "node:child_process";

function run(command, args, { cwd } = {}) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trimEnd();
}

export function hostFor(config) {
  const name = config.host ?? "github";
  const base = config.defaultBranch ?? "main";
  if (name === "github") {
    return {
      name,
      cli: "gh",
      // Open PRs from this head branch, as [{number,url}].
      openRequests(branch, opts) {
        const out = run("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url"], opts);
        return JSON.parse(out || "[]");
      },
      createRequest({ branch, title, body, label }, opts) {
        return run("gh", ["pr", "create", "--base", base, "--head", branch, "--title", title, "--body", body, "--label", label], opts);
      },
      // "open" | "merged" | "closed" | "none": the most advanced state any
      // request from this head branch reached.
      requestState(branch, opts) {
        const out = run("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", "state"], opts);
        const states = JSON.parse(out || "[]").map((pr) => String(pr.state).toLowerCase());
        if (states.includes("merged")) return "merged";
        if (states.includes("open")) return "open";
        if (states.length) return "closed";
        return "none";
      },
      requestBody(number, opts) {
        return run("gh", ["pr", "view", String(number), "--json", "body", "--jq", ".body"], opts);
      },
      postNote(number, text, opts) {
        return run("gh", ["pr", "comment", String(number), "--body", text], opts);
      },
    };
  }
  if (name === "gitlab") {
    return {
      name,
      cli: "glab",
      openRequests(branch, opts) {
        const out = run("glab", ["mr", "list", "--source-branch", branch, "--output", "json"], opts);
        return JSON.parse(out || "[]").map((mr) => ({ number: mr.iid, url: mr.web_url }));
      },
      createRequest({ branch, title, body, label }, opts) {
        return run("glab", ["mr", "create", "--source-branch", branch, "--target-branch", base, "--title", title, "--description", body, "--label", label, "--yes"], opts);
      },
      requestState(branch, opts) {
        const out = run("glab", ["mr", "list", "--source-branch", branch, "--all", "--output", "json"], opts);
        const states = JSON.parse(out || "[]").map((mr) => String(mr.state).toLowerCase());
        if (states.includes("merged")) return "merged";
        if (states.includes("opened") || states.includes("open")) return "open";
        if (states.length) return "closed";
        return "none";
      },
      requestBody(number, opts) {
        const out = run("glab", ["mr", "view", String(number), "--output", "json"], opts);
        return JSON.parse(out || "{}").description ?? "";
      },
      postNote(number, text, opts) {
        return run("glab", ["mr", "note", String(number), "--message", text], opts);
      },
    };
  }
  throw new Error(`sdlc/config.json: unknown host "${name}" (expected "github" or "gitlab")`);
}
