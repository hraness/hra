import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  auditCiRefs,
  classifyCiJob,
  parseCiAuditArguments,
} from "./ci-ref-audit";

describe("CI ref audit", () => {
  test("requires a bounded absolute repository root override", () => {
    expect(parseCiAuditArguments([], "/repo")).toEqual({
      check: false,
      json: false,
      root: "/repo",
    });
    expect(() => parseCiAuditArguments(["--root", "relative"], "/repo")).toThrow("absolute");
    expect(() => parseCiAuditArguments(["--root", "/one", "--root", "/two"], "/repo"))
      .toThrow("only once");
  });

  test("classifies broad complete history as unsafe and explicit ref allowlists as governed", () => {
    expect(classifyCiJob({
      completeHistoryConsumer: true,
      job: {
        steps: [{
          uses: "actions/checkout@sha",
          with: { "fetch-depth": 0 },
        }, { run: "bun run check" }],
      },
    }).kind).toBe("unsafe");

    expect(classifyCiJob({
      completeHistoryConsumer: true,
      job: {
        steps: [{
          uses: "actions/checkout@sha",
          with: {
            "fetch-depth": 1,
            "fetch-tags": false,
            "persist-credentials": false,
            ref: "${{ github.sha }}",
          },
        }, {
          run: `git fetch --force --no-tags --unshallow origin \\
            "+$VERIFIED_SHA:refs/remotes/ci/verified"
            git for-each-ref --format='%(refname)'
            echo "Unexpected ref"`,
        }],
      },
    }).kind).toBe("governed");

    expect(classifyCiJob({
      completeHistoryConsumer: false,
      job: { steps: [{ uses: "actions/checkout@sha", with: { "fetch-depth": 0 } }] },
    }).kind).toBe("review");
  });

  test("parses bounded YAML and fails closed on malformed workflows", () => {
    const root = mkdtempSync(join(tmpdir(), "hra-ci-ref-audit-"));
    const workflows = join(root, ".github", "workflows");
    const scripts = join(root, "scripts");
    mkdirSync(workflows, { recursive: true });
    mkdirSync(scripts);
    Bun.spawnSync({ cmd: ["git", "init", "-q", "-b", "main"], cwd: root });
    writeFileSync(join(scripts, "history.ts"), `Bun.spawnSync(["git", "rev-list", "--all"]);\n`);
    const workflow = join(workflows, "ci.yml");
    writeFileSync(workflow, `name: CI
on: push
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@sha
        with:
          fetch-depth: 0
      - run: bun run check
`);
    Bun.spawnSync({ cmd: ["git", "add", "."], cwd: root });
    try {
      expect(auditCiRefs(root)).toMatchObject({
        completeHistoryConsumer: true,
        counts: { unsafe: 1 },
      });
      rmSync(join(scripts, "history.ts"));
      expect(auditCiRefs(root)).toMatchObject({
        completeHistoryConsumer: false,
        counts: { review: 1, unsafe: 0 },
      });
      writeFileSync(workflow, "jobs: [unterminated\n");
      expect(() => auditCiRefs(root)).toThrow();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
