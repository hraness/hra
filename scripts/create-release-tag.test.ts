import { describe, expect, test } from "bun:test";

import {
  assertActiveCiWorkflow,
  assertExactOriginUrls,
  assertMainRulesets,
  assertMonotonicReleaseTag,
  assertReleaseRepository,
  assertReleaseRulesets,
  assertTransparentGitIndex,
  compareStableVersions,
  createReleaseTag,
  parseRemoteTags,
  parseStableVersion,
} from "./create-release-tag";

const sha = "1111111111111111111111111111111111111111";
const object = "2222222222222222222222222222222222222222";
const nextObject = "3333333333333333333333333333333333333333";
const acceptReleasePins = async (): Promise<void> => {};

function ruleset(name: string, rules: readonly string[], bypass = false): unknown {
  return {
    bypass_actors: bypass
      ? [{ actor_id: 894119, actor_type: "User", bypass_mode: "always" }]
      : [],
    conditions: { ref_name: { exclude: [], include: ["refs/tags/v*"] } },
    enforcement: "active",
    name,
    rules: rules.map((type) => ({ type })),
    target: "tag",
  };
}

function fakeReleaseRunner(options: Readonly<{
  dirtyOnStatusRead?: number;
  hiddenIndex?: "assume-unchanged" | "skip-worktree";
  mainAdvancesBeforePush?: boolean;
  published?: boolean;
  pushFails?: boolean;
  replacementRef?: boolean;
  wrongUser?: boolean;
}> = {}): { readonly calls: string[]; readonly runner: (command: readonly string[]) => {
  exitCode: number;
  stderr: string;
  stdout: string;
} } {
  const calls: string[] = [];
  let mainReadCount = 0;
  let statusReadCount = 0;
  const result = (stdout = "", exitCode = 0, stderr = "") => ({ exitCode, stderr, stdout });
  const immutableMain = {
    bypass_actors: [],
    conditions: { ref_name: { exclude: [], include: ["refs/heads/main"] } },
    enforcement: "active",
    name: "Immutable main",
    rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "required_linear_history" }],
    target: "branch",
  };
  const protectMain = {
    bypass_actors: [],
    conditions: { ref_name: { exclude: [], include: ["refs/heads/main"] } },
    enforcement: "active",
    name: "Protect main",
    rules: [
      {
        parameters: {
          allowed_merge_methods: ["squash", "rebase"],
          require_extra_approval_for_unattributed_changes: true,
          required_approving_review_count: 0,
          required_review_thread_resolution: true,
        },
        type: "pull_request",
      },
      {
        parameters: {
          do_not_enforce_on_create: false,
          required_status_checks: [{ context: "Required", integration_id: 15368 }],
          strict_required_status_checks_policy: true,
        },
        type: "required_status_checks",
      },
    ],
    target: "branch",
  };
  const details = new Map<string, unknown>([
    ["1", ruleset("Release tag creation", ["creation"], true)],
    ["2", ruleset("Immutable version tags", ["deletion", "update"])],
    ["3", immutableMain],
    ["4", protectMain],
  ]);
  const runner = (command: readonly string[]) => {
    const key = command.join("\u0000");
    calls.push(key);
    if (key === "gh\u0000api\u0000user") {
      return result(JSON.stringify({ id: options.wrongUser === true ? 7 : 894119, type: "User" }));
    }
    if (key === "gh\u0000api\u0000repos/hraness/oompa") return result(JSON.stringify({
      default_branch: "main",
      full_name: "hraness/oompa",
      id: 1343008607,
      owner: { id: 307125679 },
      private: false,
      visibility: "public",
    }));
    if (key === "git\u0000rev-parse\u0000--show-toplevel") return result(process.cwd());
    if (key === "git\u0000for-each-ref\u0000--format=%(refname)\u0000refs/replace") {
      return result(options.replacementRef === true
        ? `refs/replace/${sha}\n`
        : "");
    }
    if (key === "git\u0000status\u0000--porcelain=v1\u0000--untracked-files=all") {
      statusReadCount += 1;
      return result(
        options.dirtyOnStatusRead !== undefined
          && statusReadCount >= options.dirtyOnStatusRead
          ? " M src/install-preflight.ts\n"
          : "",
      );
    }
    if (key === "git\u0000ls-files\u0000-v\u0000-z") {
      if (options.hiddenIndex === "assume-unchanged") return result("h package.json\0");
      if (options.hiddenIndex === "skip-worktree") return result("S package.json\0");
      return result("H package.json\0");
    }
    if (key === "git\u0000branch\u0000--show-current") return result("main");
    if (key === "git\u0000remote\u0000get-url\u0000--all\u0000origin") {
      return result("https://github.com/hraness/oompa.git");
    }
    if (key === "git\u0000remote\u0000get-url\u0000--push\u0000--all\u0000origin") {
      return result("git@github.com:hraness/oompa.git");
    }
    if (key === "git\u0000rev-parse\u0000--verify\u0000HEAD^{commit}") return result(sha);
    if (key === "git\u0000show\u0000HEAD:package.json") {
      return result(JSON.stringify({ name: "@hraness/oompa", version: "0.6.1" }));
    }
    const committedSourcePrefix = `git\u0000show\u0000${sha}:`;
    if (key.startsWith(committedSourcePrefix)) {
      const path = key.slice(committedSourcePrefix.length);
      return result(path === "package.json"
        ? `${JSON.stringify({ name: "@hraness/oompa", version: "0.6.1" })}\n`
        : `// committed ${path}\n`);
    }
    if (key === "git\u0000ls-remote\u0000--heads\u0000origin\u0000refs/heads/main") {
      mainReadCount += 1;
      const current = options.mainAdvancesBeforePush === true && mainReadCount > 1 ? object : sha;
      return result(`${current}\trefs/heads/main\n`);
    }
    if (key === "git\u0000ls-remote\u0000--tags\u0000origin\u0000refs/tags/v*") {
      const current = `${object}\trefs/tags/v0.6.0\n${sha}\trefs/tags/v0.6.0^{}\n`;
      return result(options.published === true
        ? `${current}${nextObject}\trefs/tags/v0.6.1\n${sha}\trefs/tags/v0.6.1^{}\n`
        : current);
    }
    if (key.startsWith("gh\u0000api\u0000--method\u0000GET\u0000repos/hraness/oompa/rulesets\u0000")) {
      return result(JSON.stringify([
        { id: 1, name: "Release tag creation" },
        { id: 2, name: "Immutable version tags" },
        { id: 3, name: "Immutable main" },
        { id: 4, name: "Protect main" },
      ]));
    }
    const detailPrefix = "gh\u0000api\u0000repos/hraness/oompa/rulesets/";
    if (key.startsWith(detailPrefix)) return result(JSON.stringify(details.get(key.slice(detailPrefix.length))));
    if (key === "gh\u0000api\u0000repos/hraness/oompa/actions/workflows/ci.yml") return result(JSON.stringify({
      id: 340428685,
      name: "CI",
      path: ".github/workflows/ci.yml",
      state: "active",
    }));
    if (key.includes("environments/npm-release")) throw new Error("Canonical tagging must not require npm environment access");

    if (key.includes("actions/workflows/ci.yml/runs")) return result(JSON.stringify({
      total_count: 1,
      workflow_runs: [{
        conclusion: "success",
        event: "push",
        head_branch: "main",
        head_repository: { full_name: "hraness/oompa" },
        head_sha: sha,
        id: 10,
        path: ".github/workflows/ci.yml",
        repository: { full_name: "hraness/oompa" },
        run_attempt: 1,
        status: "completed",
      }],
    }));
    if (key.includes("actions/runs/10/jobs")) return result(JSON.stringify({
      jobs: [{
        conclusion: "success",
        head_sha: sha,
        id: 11,
        name: "Required",
        run_attempt: 1,
        run_id: 10,
        status: "completed",
      }],
      total_count: 1,
    }));
    if (key === "git\u0000show-ref\u0000--verify\u0000--quiet\u0000refs/tags/v0.6.1") return result("", 1);
    if (key === `git\u0000-c\u0000tag.gpgSign=false\u0000tag\u0000-a\u0000v0.6.1\u0000-m\u0000Release v0.6.1\u0000${sha}`) {
      return result();
    }
    if (key === "git\u0000rev-parse\u0000--verify\u0000v0.6.1^{tag}") return result(nextObject);
    if (key === "git\u0000push\u0000origin\u0000refs/tags/v0.6.1:refs/tags/v0.6.1") {
      return options.pushFails === true ? result("", 1, "push failed") : result();
    }
    if (key === "git\u0000ls-remote\u0000--tags\u0000origin\u0000refs/tags/v0.6.1\u0000refs/tags/v0.6.1^{}") {
      return result(`${nextObject}\trefs/tags/v0.6.1\n${sha}\trefs/tags/v0.6.1^{}\n`);
    }
    if (key === `git\u0000update-ref\u0000-d\u0000refs/tags/v0.6.1\u0000${nextObject}`) return result();
    throw new Error(`Unexpected fake command: ${key}`);
  };
  return { calls, runner };
}

describe("owner-authorized release tag", () => {
  test("refuses assume-unchanged and skip-worktree index entries before tag mutation", async () => {
    expect(() => assertTransparentGitIndex("H package.json\0")).not.toThrow();
    for (const hiddenIndex of ["assume-unchanged", "skip-worktree"] as const) {
      const fixture = fakeReleaseRunner({ hiddenIndex });
      await expect(createReleaseTag(fixture.runner, async () => ({
        name: "@hraness/oompa",
        version: "0.6.1",
      }))).rejects.toThrow("skip-worktree or assume-unchanged");
      expect(fixture.calls.some((call) => call.includes("\u0000tag\u0000-a\u0000"))).toBe(false);
      expect(fixture.calls.some((call) => call.includes("\u0000push\u0000"))).toBe(false);
    }
  });

  test("refuses replacement refs before reading or tagging committed installer blobs", async () => {
    const fixture = fakeReleaseRunner({ replacementRef: true });
    await expect(createReleaseTag(fixture.runner, async () => ({
      name: "@hraness/oompa",
      version: "0.6.1",
    }), acceptReleasePins)).rejects.toThrow("replacement refs");
    expect(fixture.calls.some((call) => call.startsWith(`git\u0000show\u0000${sha}:`))).toBe(false);
    expect(fixture.calls.some((call) => call.includes("\u0000tag\u0000-a\u0000"))).toBe(false);
    expect(fixture.calls.some((call) => call.startsWith("git\u0000push\u0000"))).toBe(false);
  });

  test("uses the committed manifest as release authority", async () => {
    const fixture = fakeReleaseRunner();
    await expect(createReleaseTag(fixture.runner, async () => ({
      name: "@hraness/oompa",
      version: "0.6.2",
    }))).rejects.toThrow("does not match the exact committed package manifest");
    expect(fixture.calls.some((call) => call.includes("\u0000tag\u0000-a\u0000"))).toBe(false);
    expect(fixture.calls.some((call) => call.startsWith("git\u0000push\u0000"))).toBe(false);
  });

  test("orders canonical stable versions without number precision loss", () => {
    expect(compareStableVersions(parseStableVersion("1.10.0"), parseStableVersion("1.9.999"))).toBe(1);
    expect(compareStableVersions(parseStableVersion("9007199254740993.0.0"), parseStableVersion("2.0.0"))).toBe(1);
    expect(() => parseStableVersion("01.2.3")).toThrow("canonical stable semantic version");
    expect(() => parseStableVersion("1.2.3-beta.1")).toThrow("canonical stable semantic version");
  });

  test("parses annotated remote tags and refuses malformed or duplicate inventory", () => {
    expect(parseRemoteTags(`${object}\trefs/tags/v0.5.0\n${sha}\trefs/tags/v0.5.0^{}\n`)).toEqual([
      { commit: sha, object, tag: "v0.5.0" },
    ]);
    expect(() => parseRemoteTags("not-a-tag\n")).toThrow("malformed");
    expect(() => parseRemoteTags(`${object}\trefs/tags/v0.5.0\n${object}\trefs/tags/v0.5.0\n`))
      .toThrow("duplicate tag ref");
  });

  test("requires a new monotonic tag or proves the exact existing annotated tag", () => {
    const existing = parseRemoteTags(`${object}\trefs/tags/v0.6.0\n${sha}\trefs/tags/v0.6.0^{}\n`);
    expect(assertMonotonicReleaseTag("0.6.1", sha, existing)).toEqual({
      alreadyPublished: false,
      tag: "v0.6.1",
    });
    expect(assertMonotonicReleaseTag("0.6.0", sha, existing)).toEqual({
      alreadyPublished: true,
      tag: "v0.6.0",
    });
    expect(() => assertMonotonicReleaseTag("0.5.0", sha, existing)).toThrow("not newer");
    expect(() => assertMonotonicReleaseTag("0.6.0", object, existing)).toThrow("different or lightweight");
  });

  test("requires split creation and immutable rulesets with only the owner creation bypass", () => {
    const list = [
      { id: 1, name: "Release tag creation" },
      { id: 2, name: "Immutable version tags" },
    ];
    const details = new Map<string, unknown>([
      ["Release tag creation", ruleset("Release tag creation", ["creation"], true)],
      ["Immutable version tags", ruleset("Immutable version tags", ["update", "deletion"])],
    ]);
    expect(() => assertReleaseRulesets(list, details)).not.toThrow();
    details.set("Release tag creation", ruleset("Release tag creation", ["creation"]));
    expect(() => assertReleaseRulesets(list, details)).toThrow("unexpected bypass authority");
    details.set("Release tag creation", ruleset("Release tag creation", ["creation"], true));
    details.set("Immutable version tags", ruleset("Immutable version tags", ["creation", "update", "deletion"]));
    expect(() => assertReleaseRulesets(list, details)).toThrow("unexpected rules");
  });

  test("requires exact active CI and no-bypass main protection", () => {
    expect(() => assertActiveCiWorkflow({
      id: 340428685,
      name: "CI",
      path: ".github/workflows/ci.yml",
      state: "active",
    })).not.toThrow();
    expect(() => assertActiveCiWorkflow({
      id: 340428685,
      name: "CI",
      path: ".github/workflows/ci.yml",
      state: "disabled_manually",
    })).toThrow("not the exact active");

    const list = [
      { id: 1, name: "Immutable main" },
      { id: 2, name: "Protect main" },
    ];
    const branch = (name: string, rules: readonly unknown[]) => ({
      bypass_actors: [],
      conditions: { ref_name: { exclude: [], include: ["refs/heads/main"] } },
      enforcement: "active",
      name,
      rules,
      target: "branch",
    });
    const details = new Map<string, unknown>([
      ["Immutable main", branch("Immutable main", [
        { type: "deletion" }, { type: "non_fast_forward" }, { type: "required_linear_history" },
      ])],
      ["Protect main", branch("Protect main", [
        {
          parameters: {
            allowed_merge_methods: ["squash", "rebase"],
            require_extra_approval_for_unattributed_changes: true,
            required_approving_review_count: 0,
            required_review_thread_resolution: true,
          },
          type: "pull_request",
        },
        {
          parameters: {
            do_not_enforce_on_create: false,
            required_status_checks: [{ context: "Required", integration_id: 15368 }],
            strict_required_status_checks_policy: true,
          },
          type: "required_status_checks",
        },
      ])],
    ]);
    expect(() => assertMainRulesets(list, details)).not.toThrow();
    const drifted = structuredClone(details.get("Protect main")) as { bypass_actors: unknown[] };
    drifted.bypass_actors = [{ actor_id: 1, actor_type: "User", bypass_mode: "always" }];
    details.set("Protect main", drifted);
    expect(() => assertMainRulesets(list, details)).toThrow("without bypass");
  });

  test("requires the exact public repository identity", () => {
    const repository = {
      default_branch: "main",
      full_name: "hraness/oompa",
      id: 1343008607,
      owner: { id: 307125679 },
      private: false,
      visibility: "public",
    };
    expect(() => assertReleaseRepository(repository)).not.toThrow();
    expect(() => assertReleaseRepository({ ...repository, private: true, visibility: "private" })).toThrow();
    expect(() => assertReleaseRepository({ ...repository, id: 1 })).toThrow("wrong GitHub repository identity");
  });

  test("requires one exact fetch and effective push origin", () => {
    expect(() => assertExactOriginUrls(
      "https://github.com/hraness/oompa.git",
      "git@github.com:hraness/oompa.git",
    )).not.toThrow();
    expect(() => assertExactOriginUrls(
      "https://github.com/hraness/oompa.git",
      "https://github.com/attacker/hra.git",
    )).toThrow("hraness/oompa as origin");
    expect(() => assertExactOriginUrls(
      "https://github.com/hraness/oompa.git\nhttps://github.com/attacker/hra.git",
      "https://github.com/hraness/oompa.git",
    )).toThrow("hraness/oompa as origin");
  });

  test("refuses release-pin drift before any local tag effect", async () => {
    const fake = fakeReleaseRunner();
    let observedTag: string | undefined;
    let observedSources: readonly string[] | undefined;
    await expect(createReleaseTag(fake.runner, async () => ({
      name: "@hraness/oompa",
      version: "0.6.1",
    }), async (sources, tag) => {
      observedTag = tag;
      observedSources = Object.keys(sources).sort();
      throw new Error("installer release pins drifted");
    })).rejects.toThrow("installer release pins drifted");
    expect(observedTag).toBe("v0.6.1");
    expect(observedSources).toEqual(["cli", "manifest", "normalizer", "preflight", "runtime"]);
    expect(fake.calls.some((call) => call.includes("\u0000tag\u0000-a\u0000"))).toBe(false);
    expect(fake.calls.some((call) => call.startsWith("git\u0000push\u0000"))).toBe(false);
  });

  test("refuses checkout drift after pin proof and again before tag creation", async () => {
    for (const dirtyOnStatusRead of [2, 3]) {
      const fake = fakeReleaseRunner({ dirtyOnStatusRead });
      await expect(createReleaseTag(fake.runner, async () => ({
        name: "@hraness/oompa",
        version: "0.6.1",
      }), acceptReleasePins)).rejects.toThrow("working-tree drift");
      expect(fake.calls.some((call) => call.includes("\u0000tag\u0000-a\u0000"))).toBe(false);
      expect(fake.calls.some((call) => call.startsWith("git\u0000push\u0000"))).toBe(false);
    }
  });

  test("revalidates current main immediately before one exact tag push", async () => {
    const fake = fakeReleaseRunner();
    await expect(createReleaseTag(fake.runner, async () => ({
      name: "@hraness/oompa",
      version: "0.6.1",
    }), acceptReleasePins)).resolves.toContain("Created immutable v0.6.1");
    const tag = fake.calls.findIndex((call) => call.includes("\u0000tag\u0000-a\u0000v0.6.1"));
    const push = fake.calls.indexOf("git\u0000push\u0000origin\u0000refs/tags/v0.6.1:refs/tags/v0.6.1");
    const ci = fake.calls.findIndex((call) => call.includes("actions/runs/10/jobs"));
    const finalMainRead = fake.calls.lastIndexOf(
      "git\u0000ls-remote\u0000--heads\u0000origin\u0000refs/heads/main",
    );
    expect(tag).toBeGreaterThan(ci);
    expect(finalMainRead).toBe(tag + 2);
    expect(push).toBe(finalMainRead + 1);
    expect(fake.calls.at(-1)).toBe(
      "git\u0000ls-remote\u0000--tags\u0000origin\u0000refs/tags/v0.6.1\u0000refs/tags/v0.6.1^{}",
    );
  });

  test("compare-deletes its transient local tag when main advances during preflight", async () => {
    const fake = fakeReleaseRunner({ mainAdvancesBeforePush: true });
    await expect(createReleaseTag(fake.runner, async () => ({
      name: "@hraness/oompa",
      version: "0.6.1",
    }), acceptReleasePins)).rejects.toThrow("Remote main advanced during release tag preflight");
    expect(fake.calls.some((call) => call.startsWith("git\u0000push\u0000"))).toBe(false);
    expect(fake.calls.slice(-2)).toEqual([
      `git\u0000update-ref\u0000-d\u0000refs/tags/v0.6.1\u0000${nextObject}`,
      "git\u0000show-ref\u0000--verify\u0000--quiet\u0000refs/tags/v0.6.1",
    ]);
  });

  test("performs no repository mutation after an authorization failure", async () => {
    const fake = fakeReleaseRunner({ wrongUser: true });
    await expect(createReleaseTag(fake.runner, async () => ({
      name: "@hraness/oompa",
      version: "0.6.1",
    }))).rejects.toThrow("immutable owner User ID 894119");
    expect(fake.calls).toEqual(["gh\u0000api\u0000user"]);
  });

  test("compare-deletes only its exact transient local tag after a failed push", async () => {
    const fake = fakeReleaseRunner({ pushFails: true });
    await expect(createReleaseTag(fake.runner, async () => ({
      name: "@hraness/oompa",
      version: "0.6.1",
    }), acceptReleasePins)).rejects.toThrow("push failed");
    const push = fake.calls.indexOf("git\u0000push\u0000origin\u0000refs/tags/v0.6.1:refs/tags/v0.6.1");
    expect(fake.calls.slice(push + 1)).toEqual([
      `git\u0000update-ref\u0000-d\u0000refs/tags/v0.6.1\u0000${nextObject}`,
      "git\u0000show-ref\u0000--verify\u0000--quiet\u0000refs/tags/v0.6.1",
    ]);
  });

  test("proves an existing exact remote tag without creating or pushing", async () => {
    const fake = fakeReleaseRunner({ published: true });
    await expect(createReleaseTag(fake.runner, async () => ({
      name: "@hraness/oompa",
      version: "0.6.1",
    }), acceptReleasePins)).resolves.toBe(`Release tag v0.6.1 already immutably names ${sha}.`);
    expect(fake.calls.some((call) => call.includes("\u0000tag\u0000-a\u0000"))).toBe(false);
    expect(fake.calls.some((call) => call.startsWith("git\u0000push\u0000"))).toBe(false);
  });
});
