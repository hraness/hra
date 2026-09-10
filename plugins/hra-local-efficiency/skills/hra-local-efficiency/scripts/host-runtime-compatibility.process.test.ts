import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const previousModule = process.env.HRA_PREVIOUS_HOST_RESOURCES_MODULE;
const currentModule = process.env.HRA_SLOPCAMERA_HOST_RESOURCES_MODULE;
const enabled = previousModule !== undefined && currentModule !== undefined;

function document(path: string): Record<string, unknown> {
  const data = readFileSync(path);
  if (data.byteLength > 65_536) throw new Error("unbounded fixture record");
  const value: unknown = JSON.parse(data.toString("utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid fixture record");
  return value as Record<string, unknown>;
}
function marker(path: string): { phase: string; profileSha256: string; version: number; amount: number } {
  const value = document(path);
  if (typeof value.phase !== "string" || typeof value.profileSha256 !== "string"
    || typeof value.version !== "number" || !Array.isArray(value.claims) || value.claims.length !== 1) {
    throw new Error("invalid fixture marker");
  }
  const claim: unknown = value.claims[0];
  if (typeof claim !== "object" || claim === null || !("amount" in claim) || typeof claim.amount !== "number") {
    throw new Error("invalid fixture claim");
  }
  return { phase: value.phase, profileSha256: value.profileSha256, version: value.version, amount: claim.amount };
}
function ticket(value: unknown): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/u.test(value)) throw new Error("invalid fixture ticket");
  return BigInt(value);
}

async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error("compatibility observation deadline expired");
    await Bun.sleep(10);
  }
}

// Explicit local qualification uses two independently pinned real libraries.
// Ordinary source tests do not download or execute a historical dependency.
describe.skipIf(!enabled)("host-runtime ledger continuity", () => {
  for (const direction of ["previous-to-current", "current-to-previous"] as const) {
    test(`${direction} serializes the same explicit HRA ledger`, async () => {
      if (previousModule === undefined || currentModule === undefined) throw new Error("missing runtime qualification inputs");
      expect(resolve(previousModule)).not.toBe(resolve(currentModule));
      const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
      expect(digest(previousModule)).not.toBe(digest(currentModule));
      const root = mkdtempSync(join(tmpdir(), "hra-runtime-continuity-"));
      const stateRoot = join(root, "host-resources-v1");
      const holderOutput = join(root, "holder.json");
      const contenderOutput = join(root, "contender.json");
      const modules = direction === "previous-to-current"
        ? [previousModule, currentModule] as const : [currentModule, previousModule] as const;
      const fixture = join(import.meta.dir, "host-runtime-compatibility.fixture.ts");
      const children: ReturnType<typeof Bun.spawn>[] = [];
      try {
        const holder = Bun.spawn([process.execPath, fixture, modules[0], stateRoot, holderOutput, "hold"],
          { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        children.push(holder);
        await until(() => existsSync(holderOutput));
        const contender = Bun.spawn([process.execPath, fixture, modules[1], stateRoot, contenderOutput, "once"],
          { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        children.push(contender);
        let markers: ReturnType<typeof marker>[] = [];
        await until(() => {
          try {
            markers = readdirSync(stateRoot).filter(name => name.startsWith("lease-"))
              .map(name => marker(join(stateRoot, name)));
            return markers.length === 2 && markers.some(marker => marker.phase === "W");
          } catch { return false; }
        });
        expect(markers.map(marker => marker.phase).sort()).toEqual(["A", "W"]);
        expect(new Set(markers.map(marker => marker.profileSha256)).size).toBe(1);
        expect(markers.every(marker => marker.version === 1 && marker.amount === 1)).toBe(true);
        expect(existsSync(contenderOutput)).toBe(false);
        await holder.stdin.write("release\n");
        await until(() => holder.exitCode !== null && contender.exitCode !== null);
        expect(holder.exitCode, await new Response(holder.stderr).text()).toBe(0);
        expect(contender.exitCode, await new Response(contender.stderr).text()).toBe(0);
        const first = document(holderOutput);
        const second = document(contenderOutput);
        expect(first.profile).toEqual({ id: "hra.local-efficiency/v1-1", capacities: [{ resource: "cpu", limit: 1 }] });
        expect(second.profile).toEqual(first.profile);
        expect(first.scope).toBe("machine");
        expect(second.scope).toBe("machine");
        expect(ticket(second.ticket)).toBeGreaterThan(ticket(first.ticket));
        expect(first.marker).toMatchObject({ profileSha256: markers[0]?.profileSha256 });
        expect(second.marker).toMatchObject({ profileSha256: markers[0]?.profileSha256 });
        expect(readdirSync(stateRoot).filter(name => name.startsWith("lease-"))).toEqual([]);
      } finally {
        for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
        await Promise.all(children.map(child => child.exited));
        rmSync(root, { recursive: true, force: true });
      }
    }, 15_000);
  }
});
