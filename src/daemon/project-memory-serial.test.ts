import { describe, expect, test } from "bun:test";

import { ProjectMemorySerialExecutor } from "./project-memory-serial.ts";

const projectA = "proj_0123456789abcdef0123456789abcdef";
const projectB = "proj_fedcba9876543210fedcba9876543210";

describe("ProjectMemorySerialExecutor", () => {
  test("serializes one project while different projects remain independent", async () => {
    const serial = new ProjectMemorySerialExecutor();
    const events: string[] = [];
    let releaseA: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const first = serial.run(projectA, async () => {
      events.push("a:first:start");
      await held;
      events.push("a:first:end");
    });
    const second = serial.run(projectA, async () => {
      events.push("a:second");
    });
    const other = serial.run(projectB, async () => {
      events.push("b");
    });

    await other;
    expect(events).toEqual(["a:first:start", "b"]);
    releaseA?.();
    await Promise.all([first, second, serial.drain()]);
    expect(events).toEqual(["a:first:start", "b", "a:first:end", "a:second"]);
  });

  test("continues after a failed predecessor and rejects invalid project ids", async () => {
    const serial = new ProjectMemorySerialExecutor();
    const failed = serial.run(projectA, async () => {
      throw new Error("expected");
    });
    const recovered = serial.run(projectA, async () => "ok");

    await expect(failed).rejects.toThrow("expected");
    await expect(recovered).resolves.toBe("ok");
    expect(() => serial.run("not-a-project", async () => undefined)).toThrow();
  });
});
