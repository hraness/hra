import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { npmCryptoEnvironment, verifyNpmProvenance, withNpmProvenanceCache } from "./verify-npm-provenance";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function provenance(tufCachePath = "/fixture/tuf") {
  const sha = "a".repeat(40);
  const digest = Buffer.alloc(64, 0xab);
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ name: "pkg:npm/%40hraness/oompa@0.6.0", digest: { sha512: digest.toString("hex") } }],
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: { workflow: {
          repository: "https://github.com/hraness/oompa", path: ".github/workflows/release.yml", ref: "refs/tags/v0.6.0",
        } },
        internalParameters: { github: { event_name: "push", repository_id: "1343008607", repository_owner_id: "307125679" } },
        resolvedDependencies: [{ uri: "git+https://github.com/hraness/oompa@refs/tags/v0.6.0", digest: { gitCommit: sha } }],
      },
      runDetails: {
        builder: { id: "https://github.com/actions/runner/github-hosted" },
        metadata: { invocationId: "https://github.com/hraness/oompa/actions/runs/123/attempts/2" },
      },
    },
  };
  return {
    attemptPolicy: "exact" as const, integrity: `sha512-${digest.toString("base64")}`,
    registryKeys: {}, runId: "123", runAttempt: "2", sha, tag: "v0.6.0", tufCachePath,
    attestations: { attestations: [{ predicateType: statement.predicateType, signedAccessSignatureUrl: "", bundle: {
      dsseEnvelope: { payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify(statement)).toString("base64") },
    } }] },
  };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function withChild(
  body: (fixture: ReturnType<typeof createChild>) => Promise<void>,
  options: Parameters<typeof createChild>[0] = {},
) {
  const fixture = createChild(options);
  try { await body(fixture); } finally { await fixture.collect(); }
}

function createChild(options: {
  writeFailure?: boolean; endFailure?: boolean; pendingWrite?: boolean;
  killFailure?: boolean; pendingCancel?: boolean;
} = {}) {
  const exit = deferred<number>();
  const write = deferred<number>();
  const cancellation = deferred<undefined>();
  const signals: (number | NodeJS.Signals | undefined)[] = [];
  const streams = [0, 1].map(() => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
      cancel() { closed = true; return options.pendingCancel ? cancellation.promise : undefined; },
    });
    return {
      stream,
      send(bytes: Uint8Array) { controller.enqueue(bytes); },
      fail() { closed = true; controller.error(new Error("private reader diagnostic")); },
      close() { if (!closed) { closed = true; controller.close(); } },
    };
  });
  const stdout = streams[0]!;
  const stderr = streams[1]!;
  const child = {
    exited: exit.promise, stdout: stdout.stream, stderr: stderr.stream,
    stdin: {
      write() {
        if (options.writeFailure) throw new Error("private stdin diagnostic");
        return options.pendingWrite ? write.promise : 1;
      },
      end() {
        if (options.endFailure) throw new Error("private stdin diagnostic");
        return 1;
      },
    },
    kill(signal?: number | NodeJS.Signals) {
      signals.push(signal);
      if (options.killFailure) throw new Error("private kill diagnostic");
    },
  };
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => child as unknown as ReturnType<typeof Bun.spawn>);
  const originalTimer = globalThis.setTimeout;
  const deadlines = new Map<number, () => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const clock = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, milliseconds: number) => {
    deadlines.set(milliseconds, callback);
    const timer = originalTimer(() => {}, 120_000);
    timers.add(timer);
    return timer;
  }) as typeof setTimeout);
  let settled = false;
  const result = verifyNpmProvenance(provenance()).then(
    () => { settled = true; return undefined; },
    (error: unknown) => { settled = true; return error; },
  );
  return {
    stdout, stderr, signals, deadlines, exit, write, cancellation, result,
    settled: () => settled,
    async collect() {
      write.resolve(1); cancellation.resolve(undefined); stdout.close(); stderr.close(); exit.resolve(0);
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([result, new Promise<never>((_resolve, reject) => {
          cleanupTimer = originalTimer(() => reject(new Error("Synthetic crypto fixture did not settle.")), 1_000);
        })]);
      } finally {
        spawn.mockRestore(); clock.mockRestore();
        for (const timer of timers) clearTimeout(timer);
        if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
      }
    },
  };
}

for (const failure of ["timeout", "stdout overflow", "stderr overflow", "stdout reader", "stderr reader", "stdin write", "stdin end"] as const) {
  test(`collects exit and both readers before rejecting ${failure}`, async () => {
    await withChild(async (fixture) => {
      await turn();
      if (failure === "timeout") {
        expect(fixture.deadlines.has(60_000)).toBe(true);
        fixture.deadlines.get(60_000)!();
      } else if (failure.includes("overflow")) {
        (failure.startsWith("stdout") ? fixture.stdout : fixture.stderr).send(Buffer.alloc(8 * 1024 + 1));
      } else if (failure.includes("reader")) {
        (failure.startsWith("stdout") ? fixture.stdout : fixture.stderr).fail();
      }
      await turn();
      expect(fixture.signals).toEqual([9]);
      expect(fixture.settled()).toBe(false);
      fixture.stdout.close(); fixture.stderr.close();
      await turn();
      expect(fixture.settled()).toBe(false);
      fixture.exit.resolve(9);
      const error = await fixture.result;
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("private");
    }, { writeFailure: failure === "stdin write", endFailure: failure === "stdin end" });
  });
}

test("the operation deadline covers blocked stdin before its write settles", async () => {
  await withChild(async (fixture) => {
    await turn();
    expect(fixture.deadlines.has(60_000)).toBe(true);
    fixture.deadlines.get(60_000)!();
    await turn();
    expect(fixture.signals).toEqual([9]);
    expect(fixture.settled()).toBe(false);
    fixture.write.resolve(1); fixture.stdout.close(); fixture.stderr.close(); fixture.exit.resolve(9);
    expect(await fixture.result).toBeInstanceOf(Error);
  }, { pendingWrite: true });
});

test("success waits for exit, stdout EOF and stderr EOF", async () => {
  await withChild(async (fixture) => {
    fixture.stdout.send(Buffer.from("verified\n"));
    fixture.stdout.close(); fixture.exit.resolve(0);
    await turn();
    expect(fixture.settled()).toBe(false);
    fixture.stderr.close();
    expect(await fixture.result).toBeUndefined();
    expect(fixture.signals).toEqual([]);
  });
});

test("a thrown kill does not report collection or expose its diagnostic", async () => {
  await withChild(async (fixture) => {
    await turn(); fixture.deadlines.get(60_000)!(); await turn();
    expect(fixture.signals).toEqual([9]);
    expect(fixture.settled()).toBe(false);
    fixture.deadlines.get(5_000)!();
    expect(String(await fixture.result)).toContain("collection is unproved; retain its TUF cache");
    expect(String(await fixture.result)).not.toContain("private");
  }, { killFailure: true });
});

test("a rejected exit promise cannot prove collection even after both EOFs", async () => {
  await withChild(async (fixture) => {
    fixture.exit.reject(new Error("private exit diagnostic"));
    await turn();
    expect(fixture.signals).toEqual([9]);
    expect(fixture.settled()).toBe(false);
    fixture.stdout.close(); fixture.stderr.close();
    expect(String(await fixture.result)).toContain("collection is unproved; retain its TUF cache");
  });
});

for (const unsettled of ["exit", "stdin", "reader cancellation"] as const) {
  test(`collection expiry retains the cache when ${unsettled} remains unsettled`, async () => {
    await withChild(async (fixture) => {
      await turn();
      if (unsettled === "reader cancellation") fixture.stdout.send(Buffer.alloc(8193));
      else fixture.deadlines.get(60_000)!();
      await turn();
      if (unsettled !== "exit") fixture.exit.resolve(9);
      fixture.stdout.close(); fixture.stderr.close();
      await turn();
      expect(fixture.settled()).toBe(false);
      expect(fixture.deadlines.has(5_000)).toBe(true);
      fixture.deadlines.get(5_000)!();
      expect(String(await fixture.result)).toContain("collection is unproved; retain its TUF cache");
      expect(fixture.signals).toEqual([9]);
    }, { pendingWrite: unsettled === "stdin", pendingCancel: unsettled === "reader cancellation" });
  });
}

test("simultaneous output failures request termination only once", async () => {
  await withChild(async (fixture) => {
    fixture.stdout.send(Buffer.alloc(8193)); fixture.stderr.send(Buffer.alloc(8193));
    await turn();
    expect(fixture.signals).toEqual([9]);
    expect(fixture.settled()).toBe(false);
    fixture.exit.resolve(9);
    expect(String(await fixture.result)).toContain("output exceeded its bound");
  });
});

for (const [caller, purpose] of [["publish-npm-release.ts", "publish"], ["check-public-release.ts", "readback"]] as const) {
  test(`${caller} uses the tested cache owner and retains failed evidence`, async () => {
    const source = await readFile(resolve(import.meta.dir, caller), "utf8");
    expect(source).toContain(`await withNpmProvenanceCache("${purpose}", async (tufCachePath) => {\n`);
    expect(source).not.toContain("await rm(tufCachePath");
    for (const failure of [undefined, new Error("verification failed"), new Error("collection is unproved")]) {
      let cache: string | undefined;
      try {
        const result = withNpmProvenanceCache(purpose, async (path) => {
          cache = path;
          expect((await stat(path)).mode & 0o777).toBe(0o700);
          await writeFile(join(path, "owned"), "evidence");
          if (failure !== undefined) throw failure;
        });
        if (failure === undefined) {
          await result;
          await expect(stat(cache!)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          await expect(result).rejects.toBe(failure);
          expect(await readFile(join(cache!, "owned"), "utf8")).toBe("evidence");
        }
      } finally {
        // The callback above owns no process; its rejected promise is fully joined.
        if (cache !== undefined) await rm(cache, { recursive: true, force: true });
      }
    }
  });
}

test("real overflow kills and collects the Node helper before returning", async () => {
  const cache = await mkdtemp(join(tmpdir(), "oompa-crypto-custody-"));
  const originalSpawn = Bun.spawn;
  let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  const observation = { exited: false };
  const spawn = spyOn(Bun, "spawn").mockImplementation(((argv: string[], options: { env?: Record<string, string | undefined> }) => {
    expect(argv).toEqual(["node", resolve(import.meta.dir, "verify-npm-provenance-crypto.mjs"), "slsa",
      "v0.6.0", "a".repeat(40), "https://github.com/hraness/oompa/actions/runs/123/attempts/2", cache]);
    expect(options.env).toEqual(npmCryptoEnvironment());
    child = originalSpawn(["node", "-e", `
      const fs = require('node:fs');
      fs.writeFileSync(process.argv[1] + '/owned', 'live');
      process.stdout.write(Buffer.alloc(8193));
      setInterval(() => {}, 1000);
    `, cache], { env: npmCryptoEnvironment(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    void child.exited.then(() => { observation.exited = true; }, () => {});
    return child;
  }) as typeof Bun.spawn);
  let collected = false;
  let failure: Error | undefined;
  try {
    const error = await verifyNpmProvenance(provenance(cache)).then(() => undefined, (error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(child).toBeDefined();
    expect(observation.exited).toBe(true);
    expect(child!.signalCode).toBe("SIGKILL");
    let absent = false;
    try { process.kill(child!.pid, 0); } catch (error) {
      absent = error instanceof Error && "code" in error && error.code === "ESRCH";
    }
    expect(absent).toBe(true);
    expect(await readFile(join(cache, "owned"), "utf8")).toBe("live");
  } catch (error) {
    failure = error instanceof Error ? error : new Error("Real crypto fixture failed.", { cause: error });
  } finally {
    spawn.mockRestore();
    if (child !== undefined) {
      if (!observation.exited) {
        try { child.kill(9); } catch { /* Collection below must still be proved. */ }
      }
      const deadline = performance.now() + 1_000;
      const readers = [child.stdout, child.stderr].map(async (stream) => {
        while (stream.locked && performance.now() < deadline) await Bun.sleep(1);
        if (stream.locked) return false;
        await stream.cancel();
        return true;
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          Promise.all([child.exited, ...readers]),
          new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 1_000); }),
        ]);
        collected = result !== null && result.slice(1).every((reader) => reader === true);
      } finally { if (timer !== undefined) clearTimeout(timer); }
    }
    if (collected) await rm(cache, { recursive: true, force: true });
  }
  if (!collected) throw new Error("Real crypto fixture collection is unproved; its cache is retained.");
  if (failure !== undefined) throw failure;
});
