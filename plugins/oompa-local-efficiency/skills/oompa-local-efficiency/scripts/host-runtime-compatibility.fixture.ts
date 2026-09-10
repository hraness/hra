import { fstatSync, readSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

interface Lease {
  readonly inheritedFileDescriptor: number;
  readonly ticket: string;
  assertOwned(): Promise<void>;
}
interface Coordinator {
  readonly scope: string;
  readonly profile: unknown;
  withLease(claims: readonly { resource: string; amount: number }[], callback: (lease: Lease) => Promise<void>): Promise<void>;
}
interface Runtime {
  createHostResourceCoordinator(options: {
    profile: { id: string; capacities: readonly { resource: string; limit: number }[] };
    stateRoot: string;
    waitTimeoutMilliseconds: number;
  }): Coordinator;
}

// Test-only child: a real, independently verified library owns its ordinary lease.
const [modulePath, stateRoot, outputPath, mode] = process.argv.slice(2);
if (modulePath === undefined || stateRoot === undefined || outputPath === undefined
  || (mode !== "hold" && mode !== "once")) throw new Error("invalid compatibility fixture arguments");
const loaded: unknown = await import(pathToFileURL(modulePath).href);
if (typeof loaded !== "object" || loaded === null || !("createHostResourceCoordinator" in loaded)
  || typeof loaded.createHostResourceCoordinator !== "function") throw new Error("invalid fixture runtime");
const runtime: Runtime = { createHostResourceCoordinator: loaded.createHostResourceCoordinator as Runtime["createHostResourceCoordinator"] };
const profile = { id: "oompa.local-efficiency/v1-1", capacities: [{ resource: "cpu", limit: 1 }] };
const coordinator = runtime.createHostResourceCoordinator({ profile, stateRoot, waitTimeoutMilliseconds: 5_000 });
const deadline = setTimeout(() => process.exit(3), 10_000);
try {
  await coordinator.withLease([{ resource: "cpu", amount: 1 }], async (lease) => {
    await lease.assertOwned();
    const size = fstatSync(lease.inheritedFileDescriptor).size;
    if (size < 1 || size > 65_536) throw new Error("invalid lease marker length");
    const markerBytes = Buffer.alloc(size);
    if (readSync(lease.inheritedFileDescriptor, markerBytes, 0, size, 0) !== size) throw new Error("short marker read");
    const marker: unknown = JSON.parse(markerBytes.toString("utf8"));
    writeFileSync(outputPath, JSON.stringify({ scope: coordinator.scope, profile: coordinator.profile, ticket: lease.ticket, marker }));
    if (mode === "hold") {
      await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
      process.stdin.pause();
    }
    await lease.assertOwned();
  });
} finally {
  clearTimeout(deadline);
}
