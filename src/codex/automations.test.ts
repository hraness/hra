import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Dir } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CODEX_AUTOMATION_AUTHORITY_PAGE_ENTRY_LIMIT,
  parseCodexAutomationToml,
  readCodexAutomationAuthority,
  readCodexAutomations,
  type CodexAutomation,
} from "./automations.ts";

// The exact shape observed on disk (kb/notes/codex-schedules.md), including the
// `prompt` and `version` keys this reader must never surface.
const OBSERVED_PROMPT = "Upload this machine's local usage data to the saved account.";
const WELL_FORMED = [
  "version = 1",
  'id = "upload-usage-to-tokscale"',
  'kind = "heartbeat"',
  'name = "Upload Codex and Claude usage to Tokscale"',
  `prompt = "${OBSERVED_PROMPT}"`,
  'status = "ACTIVE"',
  'rrule = "FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=22;BYMINUTE=0"',
  'target_thread_id = "01a06277-c3f2-7360-ab88-e5cdc7aa1504"',
  "created_at = 1788358694391",
  "updated_at = 1788358694391",
  "",
].join("\n");

const MALFORMED = 'id = "broken"\nkind = "heartbeat\nname = ';

const EXPECTED: CodexAutomation = {
  cadence: "FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=22;BYMINUTE=0",
  id: "upload-usage-to-tokscale",
  kind: "heartbeat",
  label: "Upload Codex and Claude usage to Tokscale",
  status: "active",
  targetThreadId: "01a06277-c3f2-7360-ab88-e5cdc7aa1504",
  updatedAt: 1788358694391,
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function automationsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hra-codex-automations-"));
  roots.push(root);
  const directory = join(root, "automations");
  await mkdir(directory);
  return directory;
}

async function writeAutomation(
  directory: string,
  name: string,
  body: string | null,
): Promise<void> {
  await mkdir(join(directory, name));
  if (body !== null) await writeFile(join(directory, name, "automation.toml"), body);
}

describe("parseCodexAutomationToml", () => {
  test("parses the observed automation shape and never surfaces the prompt", () => {
    const automation = parseCodexAutomationToml(WELL_FORMED, "directory-name");
    expect(automation).toEqual(EXPECTED);
    expect(Object.keys(automation ?? {})).toEqual([
      "cadence",
      "id",
      "kind",
      "label",
      "status",
      "targetThreadId",
      "updatedAt",
    ]);
    const serialized = JSON.stringify(automation);
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain(OBSERVED_PROMPT);
    expect(serialized).not.toContain("version");
    expect(serialized).not.toContain("created");
  });

  test("ignores unknown and future keys", () => {
    const automation = parseCodexAutomationToml(
      [
        WELL_FORMED,
        'target_type = "thread"',
        'project_id = "p-1"',
        'model = "gpt-x"',
        'reasoning_effort = "high"',
        "next_run_at = 1788358694391",
        "",
        "[unknown_table]",
        'anything = "at all"',
        "",
      ].join("\n"),
      "directory-name",
    );
    expect(automation).toEqual(EXPECTED);
  });

  test("falls back to the directory name and tolerates absent optional fields", () => {
    const automation = parseCodexAutomationToml(
      ['kind = "heartbeat"', 'name = "   "', ""].join("\n"),
      "finish-contacts-import",
    );
    expect(automation).toEqual({
      cadence: "",
      id: "finish-contacts-import",
      kind: "heartbeat",
      label: "finish-contacts-import",
      // An absent status means "running": only an explicit PAUSED pauses.
      status: "active",
      targetThreadId: null,
      updatedAt: null,
    });
  });

  test("reads both observed rrule shapes and strips only the RRULE: prefix", () => {
    const hourly = parseCodexAutomationToml(
      ['id = "a"', 'kind = "heartbeat"', 'name = "A"', 'rrule = "FREQ=HOURLY;INTERVAL=24;BYMINUTE=0"', ""].join("\n"),
      "a",
    );
    expect(hourly?.cadence).toBe("FREQ=HOURLY;INTERVAL=24;BYMINUTE=0");

    const monthly = parseCodexAutomationToml(
      [
        'id = "b"',
        'kind = "heartbeat"',
        'name = "B"',
        'rrule = "RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1;BYHOUR=13;BYMINUTE=0;BYSECOND=0"',
        "",
      ].join("\n"),
      "b",
    );
    expect(monthly?.cadence).toBe("FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1;BYHOUR=13;BYMINUTE=0;BYSECOND=0");
    expect(monthly?.cadence.startsWith("RRULE")).toBe(false);
  });

  test("returns null for malformed TOML instead of throwing", () => {
    expect(parseCodexAutomationToml(MALFORMED, "broken")).toBeNull();
    expect(parseCodexAutomationToml("", "empty")).toBeNull();
    expect(parseCodexAutomationToml("not toml at all", "junk")).toBeNull();
  });

  test("refuses a label that carries a local path", () => {
    const pathLabel = ["", "srv", "runner", "job"].join("/");
    const parsed = parseCodexAutomationToml(
      ['id = "a"', 'kind = "heartbeat"', `name = "Nightly ${pathLabel} sweep"`, ""].join("\n"),
      "a",
    );
    expect(parsed).toBeNull();

    const homeLabel = ["~", "codex"].join("/");
    expect(
      parseCodexAutomationToml(
        ['id = "a"', 'kind = "heartbeat"', `name = "Sync ${homeLabel}"`, ""].join("\n"),
        "a",
      ),
    ).toBeNull();
  });

  test("refuses over-long and unsafe values instead of truncating them", () => {
    const longName = "n".repeat(201);
    expect(
      parseCodexAutomationToml(
        ['id = "a"', 'kind = "heartbeat"', `name = "${longName}"`, ""].join("\n"),
        "a",
      ),
    ).toBeNull();

    const longRrule = `FREQ=WEEKLY;${"BYDAY=MO,".repeat(60)}`;
    expect(longRrule.length).toBeGreaterThan(512);
    expect(
      parseCodexAutomationToml(
        ['id = "a"', 'kind = "heartbeat"', 'name = "A"', `rrule = "${longRrule}"`, ""].join("\n"),
        "a",
      ),
    ).toBeNull();

    expect(
      parseCodexAutomationToml(
        ['id = "a"', 'kind = "heartbeat"', 'name = "Bell \\u0007 ringer"', ""].join("\n"),
        "a",
      ),
    ).toBeNull();
  });

  test("maps status case-insensitively and refuses an unrecognised status", () => {
    const paused = parseCodexAutomationToml(
      ['id = "a"', 'kind = "heartbeat"', 'name = "A"', 'status = "paused"', ""].join("\n"),
      "a",
    );
    expect(paused?.status).toBe("paused");

    const active = parseCodexAutomationToml(
      ['id = "a"', 'kind = "heartbeat"', 'name = "A"', 'status = "Active"', ""].join("\n"),
      "a",
    );
    expect(active?.status).toBe("active");

    expect(
      parseCodexAutomationToml(
        ['id = "a"', 'kind = "heartbeat"', 'name = "A"', 'status = "ARCHIVED"', ""].join("\n"),
        "a",
      ),
    ).toBeNull();
  });

  test("drops an unusable updated_at and a blank target_thread_id", () => {
    const parsed = parseCodexAutomationToml(
      [
        'id = "a"',
        'kind = "heartbeat"',
        'name = "A"',
        'target_thread_id = ""',
        "updated_at = -1",
        "",
      ].join("\n"),
      "a",
    );
    expect(parsed?.targetThreadId).toBeNull();
    expect(parsed?.updatedAt).toBeNull();
  });

  test("requires a kind", () => {
    expect(
      parseCodexAutomationToml(['id = "a"', 'name = "A"', ""].join("\n"), "a"),
    ).toBeNull();
  });

  test("never trims authority-bearing heartbeat kind or target identity", () => {
    expect(
      parseCodexAutomationToml(
        ['id = "a"', 'kind = " heartbeat "', 'target_thread_id = "thread-a"', ""].join("\n"),
        "a",
      ),
    ).toBeNull();
    expect(
      parseCodexAutomationToml(
        ['id = "a"', 'kind = "heartbeat"', 'target_thread_id = " thread-a "', ""].join("\n"),
        "a",
      ),
    ).toBeNull();
  });
});

describe("readCodexAutomations", () => {
  test("returns the good automation, one diagnostic, and skips a directory with no file", async () => {
    const directory = await automationsRoot();
    await writeAutomation(directory, "a-good", WELL_FORMED);
    await writeAutomation(directory, "b-malformed", MALFORMED);
    await writeAutomation(directory, "c-empty", null);

    const scan = await readCodexAutomations({ automationsDirectory: directory });
    expect(scan.automations).toEqual([EXPECTED]);
    expect(scan.diagnostics).toEqual([{ automationId: "b-malformed", reason: "invalid_toml" }]);
  });

  test("reports an invalid_fields diagnostic without failing the scan", async () => {
    const directory = await automationsRoot();
    await writeAutomation(directory, "a-good", WELL_FORMED);
    await writeAutomation(
      directory,
      "b-unsafe-label",
      ['id = "b"', 'kind = "heartbeat"', `name = "Sweep ${["", "srv", "work"].join("/")}"`, ""].join("\n"),
    );

    const scan = await readCodexAutomations({ automationsDirectory: directory });
    expect(scan.automations.map((automation) => automation.id)).toEqual([EXPECTED.id]);
    expect(scan.diagnostics).toEqual([
      { automationId: "b-unsafe-label", reason: "invalid_fields" },
    ]);
  });

  test("falls back to the directory name when the file omits id", async () => {
    const directory = await automationsRoot();
    await writeAutomation(
      directory,
      "named-by-directory",
      ['kind = "heartbeat"', 'name = "Weekly sweep"', 'status = "PAUSED"', ""].join("\n"),
    );

    const scan = await readCodexAutomations({ automationsDirectory: directory });
    expect(scan.automations).toEqual([
      {
        cadence: "",
        id: "named-by-directory",
        kind: "heartbeat",
        label: "Weekly sweep",
        status: "paused",
        targetThreadId: null,
        updatedAt: null,
      },
    ]);
  });

  test("returns an empty scan with no diagnostics when the directory is missing", async () => {
    const directory = await automationsRoot();
    const scan = await readCodexAutomations({
      automationsDirectory: join(directory, "not-installed"),
    });
    expect(scan).toEqual({ automations: [], complete: true, diagnostics: [] });
  });

  test("honours the limit over directories sorted by name", async () => {
    const directory = await automationsRoot();
    for (const name of ["c-third", "a-first", "b-second"]) {
      await writeAutomation(
        directory,
        name,
        ['kind = "heartbeat"', `name = "${name}"`, ""].join("\n"),
      );
    }

    const limited = await readCodexAutomations({ automationsDirectory: directory, limit: 2 });
    expect(limited.complete).toBe(false);
    expect(limited.automations.map((automation) => automation.id)).toEqual([
      "a-first",
      "b-second",
    ]);

    const all = await readCodexAutomations({ automationsDirectory: directory });
    expect(all.complete).toBe(true);
    expect(all.automations.map((automation) => automation.id)).toEqual([
      "a-first",
      "b-second",
      "c-third",
    ]);

    const none = await readCodexAutomations({ automationsDirectory: directory, limit: 0 });
    expect(none).toEqual({ automations: [], complete: true, diagnostics: [] });
  });

  test("ignores dot directories and plain files beside the automations", async () => {
    const directory = await automationsRoot();
    await writeAutomation(directory, "a-good", WELL_FORMED);
    await writeFile(join(directory, ".run-jitter-salt"), "opaque");
    await mkdir(join(directory, ".hidden"));

    const scan = await readCodexAutomations({ automationsDirectory: directory });
    expect(scan.automations).toEqual([EXPECTED]);
    expect(scan.diagnostics).toEqual([]);
  });

  test("skips an oversized automation file with an unreadable diagnostic", async () => {
    const directory = await automationsRoot();
    await writeAutomation(
      directory,
      "a-huge",
      ['id = "a"', 'kind = "heartbeat"', 'name = "A"', `# ${"pad ".repeat(20_000)}`, ""].join("\n"),
    );

    const scan = await readCodexAutomations({ automationsDirectory: directory });
    expect(scan.automations).toEqual([]);
    expect(scan.diagnostics).toEqual([{ automationId: "a-huge", reason: "unreadable" }]);
  });

  test("never follows an automation.toml symlink", async () => {
    const directory = await automationsRoot();
    const outside = join(directory, "outside.toml");
    await writeFile(outside, WELL_FORMED);
    await writeAutomation(directory, "a-linked", null);
    await symlink(outside, join(directory, "a-linked", "automation.toml"));

    const scan = await readCodexAutomations({ automationsDirectory: directory });
    expect(scan.automations).toEqual([]);
    expect(scan.diagnostics).toEqual([{ automationId: "a-linked", reason: "unreadable" }]);
  });
});

describe("readCodexAutomationAuthority", () => {
  test("fairly pages beyond 200 directories without an unbounded page", async () => {
    const directory = await automationsRoot();
    const expected = Array.from(
      { length: 205 },
      (_, index) => `automation-${String(index).padStart(3, "0")}`,
    );
    for (const name of expected) {
      await writeAutomation(
        directory,
        name,
        [
          'kind = "heartbeat"',
          `target_thread_id = "thread-${name}"`,
          "",
        ].join("\n"),
      );
    }

    const observed: string[] = [];
    let after: string | null = null;
    let pages = 0;
    do {
      const scan = await readCodexAutomationAuthority({
        after,
        automationsDirectory: directory,
        kind: "page",
        limit: 50,
      });
      pages += 1;
      expect(scan.entries.length).toBeLessThanOrEqual(50);
      expect(scan.diagnostics).toEqual([]);
      observed.push(...scan.entries.map((entry) => entry.sourceDirectoryName));
      after = scan.nextCursor;
      if (scan.complete) expect(after).toBeNull();
      else expect(after).not.toBeNull();
    } while (after !== null);

    expect(pages).toBe(5);
    expect(observed.toSorted()).toEqual(expected);
  });

  test("bounds examined entries per page and reaches a valid entry across hostile prefixes", async () => {
    const directory = await automationsRoot();
    const hiddenDirectoryCount = CODEX_AUTOMATION_AUTHORITY_PAGE_ENTRY_LIMIT * 2;
    for (let index = 0; index < hiddenDirectoryCount; index += 1) {
      await mkdir(join(directory, `.ignored-${String(index).padStart(4, "0")}`));
    }
    await writeAutomation(
      directory,
      "eventual-target",
      ['kind = "heartbeat"', 'target_thread_id = "thread-eventual"', ""].join("\n"),
    );

    const observed: string[] = [];
    let after: string | null = null;
    let pages = 0;
    do {
      const scan = await readCodexAutomationAuthority({
        after,
        automationsDirectory: directory,
        kind: "page",
        limit: 50,
      });
      pages += 1;
      if (pages < 3) {
        expect(scan.complete).toBe(false);
        expect(scan.nextCursor).not.toBeNull();
      }
      observed.push(...scan.entries.map((entry) => entry.sourceDirectoryName));
      after = scan.nextCursor;
    } while (after !== null && pages < 4);

    expect(pages).toBe(3);
    expect(after).toBeNull();
    expect(observed).toEqual(["eventual-target"]);
  });

  test("fails closed on concurrent cursor use and recovers an unknown cursor without evidence", async () => {
    const directory = await automationsRoot();
    const expected = Array.from(
      { length: 10 },
      (_, index) => `concurrent-${String(index).padStart(2, "0")}`,
    );
    for (const name of expected) {
      await writeAutomation(
        directory,
        name,
        ['kind = "heartbeat"', `target_thread_id = "thread-${name}"`, ""].join("\n"),
      );
    }

    const first = await readCodexAutomationAuthority({
      automationsDirectory: directory,
      kind: "page",
      limit: 1,
    });
    expect(first).toMatchObject({ complete: false });
    if (first.nextCursor === null) throw new Error("Expected a retained authority cursor.");
    const staleCursor = first.nextCursor;
    const concurrent = await Promise.all([
      readCodexAutomationAuthority({
        after: staleCursor,
        automationsDirectory: directory,
        kind: "page",
        limit: 1,
      }),
      readCodexAutomationAuthority({
        after: staleCursor,
        automationsDirectory: directory,
        kind: "page",
        limit: 1,
      }),
    ]);
    const continued = concurrent.filter((scan) => scan.entries.length === 1);
    const refused = concurrent.filter((scan) => scan.entries.length === 0);
    expect(refused).toHaveLength(1);
    expect(continued).toHaveLength(1);
    expect(refused[0]).toMatchObject({ complete: false, diagnostics: [] });
    expect(refused[0]?.nextCursor).not.toBe(staleCursor);
    expect(continued[0]?.nextCursor).not.toBe(staleCursor);

    const observed = [
      ...first.entries.map((entry) => entry.sourceDirectoryName),
      ...continued.flatMap((scan) => scan.entries.map((entry) => entry.sourceDirectoryName)),
    ];
    let after: string | null = continued[0]?.nextCursor ?? null;
    while (after !== null) {
      const scan = await readCodexAutomationAuthority({
        after,
        automationsDirectory: directory,
        kind: "page",
        limit: 1,
      });
      observed.push(...scan.entries.map((entry) => entry.sourceDirectoryName));
      after = scan.nextCursor;
    }
    expect(observed.toSorted()).toEqual(expected);

    let refusedCursor: string | null = refused[0]?.nextCursor ?? null;
    while (refusedCursor !== null) {
      const scan = await readCodexAutomationAuthority({
        after: refusedCursor,
        automationsDirectory: directory,
        kind: "page",
        limit: 50,
      });
      refusedCursor = scan.nextCursor;
    }

    const unknownCursor = "authority_scan_00000000-0000-4000-8000-000000000000";
    const recovered = await readCodexAutomationAuthority({
      after: unknownCursor,
      automationsDirectory: directory,
      kind: "page",
      limit: 1,
    });
    expect(recovered).toMatchObject({
      complete: false,
      diagnostics: [],
      entries: [],
    });
    expect(recovered.nextCursor).not.toBeNull();
    expect(recovered.nextCursor).not.toBe(unknownCursor);

    let recoveryCursor: string | null = recovered.nextCursor;
    while (recoveryCursor !== null) {
      const scan = await readCodexAutomationAuthority({
        after: recoveryCursor,
        automationsDirectory: directory,
        kind: "page",
        limit: 50,
      });
      recoveryCursor = scan.nextCursor;
    }
  });

  test("closes retained directory handles at EOF and when a missing root resets a scan", async () => {
    const closeSpy = spyOn(Dir.prototype, "close");
    try {
      const directory = await automationsRoot();
      for (const name of ["a", "b", "c"]) {
        await writeAutomation(
          directory,
          name,
          ['kind = "heartbeat"', `target_thread_id = "thread-${name}"`, ""].join("\n"),
        );
      }

      let cursor: string | null = null;
      do {
        const scan = await readCodexAutomationAuthority({
          after: cursor,
          automationsDirectory: directory,
          kind: "page",
          limit: 1,
        });
        cursor = scan.nextCursor;
      } while (cursor !== null);
      expect(closeSpy).toHaveBeenCalledTimes(1);

      const retained = await readCodexAutomationAuthority({
        automationsDirectory: directory,
        kind: "page",
        limit: 1,
      });
      if (retained.nextCursor === null) throw new Error("Expected a retained authority cursor.");
      await rm(directory, { force: true, recursive: true });
      const reset = await readCodexAutomationAuthority({
        after: retained.nextCursor,
        automationsDirectory: directory,
        kind: "page",
        limit: 1,
      });
      expect(reset).toEqual({
        complete: true,
        diagnostics: [],
        entries: [],
        nextCursor: null,
      });
      expect(closeSpy).toHaveBeenCalledTimes(2);
    } finally {
      closeSpy.mockRestore();
    }
  });

  test("returns no authority when directory-handle cleanup initially fails", async () => {
    const closeSpy = spyOn(Dir.prototype, "close");
    closeSpy.mockImplementationOnce(() => {
      throw new Error("Synthetic directory close failure.");
    });
    try {
      const directory = await automationsRoot();
      await writeAutomation(
        directory,
        "scheduled",
        ['kind = "heartbeat"', 'target_thread_id = "thread-scheduled"', ""].join("\n"),
      );

      const scan = await readCodexAutomationAuthority({
        automationsDirectory: directory,
        kind: "page",
        limit: 50,
      });
      expect(scan).toEqual({
        complete: false,
        diagnostics: [],
        entries: [],
        nextCursor: null,
      });
      expect(closeSpy).toHaveBeenCalledTimes(2);
    } finally {
      closeSpy.mockRestore();
    }
  });

  test("revalidates exact source directories independently of page movement", async () => {
    const directory = await automationsRoot();
    await writeAutomation(
      directory,
      "scheduled-source",
      ['kind = "heartbeat"', 'target_thread_id = "thread-original"', ""].join("\n"),
    );

    const page = await readCodexAutomationAuthority({
      automationsDirectory: directory,
      kind: "page",
      limit: 50,
    });
    expect(page).toMatchObject({ complete: true, nextCursor: null });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({
      sourceDirectoryName: "scheduled-source",
      automation: { kind: "heartbeat", targetThreadId: "thread-original" },
    });
    expect(JSON.stringify(page.entries[0])).not.toContain("prompt");

    await writeFile(
      join(directory, "scheduled-source", "automation.toml"),
      ['kind = "heartbeat"', 'target_thread_id = "thread-retargeted"', ""].join("\n"),
    );
    const exact = await readCodexAutomationAuthority({
      automationsDirectory: directory,
      kind: "sources",
      sourceDirectoryNames: ["scheduled-source"],
    });
    expect(exact).toMatchObject({ complete: true, nextCursor: null });
    expect(exact.entries).toHaveLength(1);
    expect(exact.entries[0]?.automation.targetThreadId).toBe("thread-retargeted");
  });

  test("refuses unsafe exact source identities", async () => {
    const directory = await automationsRoot();
    const scan = await readCodexAutomationAuthority({
      automationsDirectory: directory,
      kind: "sources",
      sourceDirectoryNames: ["../outside"],
    });
    expect(scan).toEqual({
      complete: false,
      diagnostics: [],
      entries: [],
      nextCursor: null,
    });
  });

  test("never accepts authority through a replaced source-directory symlink", async () => {
    const directory = await automationsRoot();
    const outside = join(directory, "..", "outside-source");
    await mkdir(outside);
    await writeFile(
      join(outside, "automation.toml"),
      ['kind = "heartbeat"', 'target_thread_id = "outside-thread"', ""].join("\n"),
    );
    await symlink(outside, join(directory, "scheduled-source"));

    const scan = await readCodexAutomationAuthority({
      automationsDirectory: directory,
      kind: "sources",
      sourceDirectoryNames: ["scheduled-source"],
    });
    expect(scan).toEqual({
      complete: true,
      diagnostics: [{ automationId: "scheduled-source", reason: "unreadable" }],
      entries: [],
      nextCursor: null,
    });
  });
});
