import { describe, expect, test } from "bun:test";

import {
  HarnessRendererService,
  type HarnessRendererProjection,
  type HarnessRendererServiceError,
} from "../src/harness/renderer-service-v2";
import type { RuntimeHarnessDomainCommand } from "../../contracts/runtime";

const settings = {
  revision: 1,
  recursiveSessionsEnabled: true,
  contextQuotaBytes: 16 * 1024 * 1024,
  refinementMode: "suggest" as const,
};
const child = {
  id: "hactor_rendererfixture1",
  revision: 1,
  title: "Inspect replay",
  state: "idle" as const,
  openedPaneId: null,
  canOpen: true,
  canMessage: false,
  canStop: true,
};
const projection: HarnessRendererProjection = {
  harness: { revision: 1, settings, proposals: [] },
  panes: [{
    paneId: "pane_rendererparent01",
    harness: {
      revision: 1,
      descendants: { count: 1, truncated: false, children: [child] },
    },
  }],
};

async function expectFailure(
  operation: Promise<unknown>,
  code: HarnessRendererServiceError["code"],
): Promise<void> {
  try {
    await operation;
    throw new Error("expected renderer service failure");
  } catch (error: unknown) {
    expect(error).toMatchObject({ code });
  }
}

describe("minimal harness renderer service", () => {
  test("installs one atomic content-free projection at boot", async () => {
    const installed: unknown[] = [];
    const service = new HarnessRendererService({
      authority: {
        readProjection: () => Promise.resolve(projection),
        execute: () => Promise.reject(new Error("unused")),
      },
      projection: {
        installHarnessState: (value) => {
          installed.push(value);
        },
      },
    });
    await service.initialize();
    expect(installed).toEqual([projection]);
    expect(JSON.stringify(installed)).not.toMatch(
      /providerId|threadId|filesystemPath|transcript/iu,
    );
  });

  test("serializes commands and publishes only correlated authority outcomes", async () => {
    const installed: unknown[] = [];
    const commands: RuntimeHarnessDomainCommand[] = [];
    const service = new HarnessRendererService({
      authority: {
        readProjection: () => Promise.resolve(projection),
        execute: async (command) => {
          commands.push(command);
          await Promise.resolve();
          return {
            result: {
              type: "harnessSettings",
              harnessRevision: 2,
              settings: {
                revision: 2,
                recursiveSessionsEnabled: false,
                contextQuotaBytes: 8 * 1024 * 1024,
                refinementMode: "off",
              },
            },
            projection: {
              ...projection,
              harness: {
                ...projection.harness,
                revision: 2,
                settings: {
                  revision: 2,
                  recursiveSessionsEnabled: false,
                  contextQuotaBytes: 8 * 1024 * 1024,
                  refinementMode: "off",
                },
              },
            },
          };
        },
      },
      projection: {
        installHarnessState: (value) => {
          installed.push(value);
        },
      },
    });
    const command = {
      type: "harness.settings.update",
      expectedHarnessRevision: 1,
      expectedRevision: 1,
      recursiveSessionsEnabled: false,
      contextQuotaBytes: 8 * 1024 * 1024,
      refinementMode: "off",
    } as const;
    expect(await service.execute(command)).toMatchObject({
      type: "harnessSettings",
      harnessRevision: 2,
    });
    expect(commands).toEqual([command]);
    expect(installed).toHaveLength(1);
  });

  test("serializes callback refreshes behind committed commands", async () => {
    const installed: HarnessRendererProjection[] = [];
    const order: string[] = [];
    let current = projection;
    let releaseCommand!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseCommand = resolve;
    });
    const service = new HarnessRendererService({
      authority: {
        readProjection: () => {
          order.push("read");
          return Promise.resolve(current);
        },
        execute: async () => {
          order.push("execute:start");
          await blocked;
          current = {
            ...projection,
            harness: {
              ...projection.harness,
              revision: 2,
              settings: {
                revision: 2,
                recursiveSessionsEnabled: false,
                contextQuotaBytes: 8 * 1024 * 1024,
                refinementMode: "off",
              },
            },
          };
          order.push("execute:end");
          return {
            result: {
              type: "harnessSettings",
              harnessRevision: 2,
              settings: current.harness.settings,
            },
            projection: current,
          };
        },
      },
      projection: {
        installHarnessState: (value) => {
          installed.push(value as HarnessRendererProjection);
        },
      },
    });
    const command = service.execute({
      type: "harness.settings.update",
      expectedHarnessRevision: 1,
      expectedRevision: 1,
      recursiveSessionsEnabled: false,
      contextQuotaBytes: 8 * 1024 * 1024,
      refinementMode: "off",
    });
    const refresh = service.refresh();
    await Promise.resolve();
    expect(order).toEqual(["execute:start"]);
    releaseCommand();
    await Promise.all([command, refresh]);
    expect(order).toEqual(["execute:start", "execute:end", "read"]);
    expect(installed.map(({ harness }) => harness.revision)).toEqual([2, 2]);
  });

  test("holds a committed command response until projection capacity settles", async () => {
    let releaseProjection!: () => void;
    const capacity = new Promise<void>((resolve) => {
      releaseProjection = resolve;
    });
    let authorityCommitted = false;
    let responseSettled = false;
    const service = new HarnessRendererService({
      authority: {
        readProjection: () => Promise.resolve(projection),
        execute: () => {
          authorityCommitted = true;
          return Promise.resolve({
            result: {
              type: "harnessSettings",
              harnessRevision: 2,
              settings: { ...settings, revision: 2 },
            },
            projection: {
              ...projection,
              harness: {
                ...projection.harness,
                revision: 2,
                settings: { ...settings, revision: 2 },
              },
            },
          });
        },
      },
      projection: { installHarnessState: async () => await capacity },
    });
    const response = service.execute({
      type: "harness.settings.update",
      expectedHarnessRevision: 1,
      expectedRevision: 1,
      recursiveSessionsEnabled: true,
      contextQuotaBytes: 16 * 1024 * 1024,
      refinementMode: "suggest",
    }).then((value) => {
      responseSettled = true;
      return value;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(authorityCommitted).toBeTrue();
    expect(responseSettled).toBeFalse();

    releaseProjection();
    expect(await response).toMatchObject({
      type: "harnessSettings",
      harnessRevision: 2,
    });
  });

  test("rejects a successful-looking response with the wrong revision", async () => {
    const installed: unknown[] = [];
    const service = new HarnessRendererService({
      authority: {
        readProjection: () => Promise.resolve(projection),
        execute: () => Promise.resolve({
          result: {
            type: "harnessChild",
            parentPaneId: "pane_rendererparent01",
            parentRevision: 2,
            child: {
              ...child,
              revision: 1,
              state: "stopped",
              canOpen: false,
              canMessage: false,
              canStop: false,
            },
          },
          projection,
        }),
      },
      projection: {
        installHarnessState: (value) => {
          installed.push(value);
        },
      },
    });
    await expectFailure(service.execute({
      type: "harness.child.stop",
      parentPaneId: "pane_rendererparent01",
      childId: child.id,
      expectedParentRevision: 1,
      expectedChildRevision: 1,
    }), "authority_conflict");
    expect(installed).toHaveLength(0);
  });

  test("quiesces the serial tail and rejects later commands", async () => {
    const service = new HarnessRendererService({
      authority: {
        readProjection: () => Promise.resolve(projection),
        execute: () => Promise.reject(new Error("unused")),
      },
      projection: { installHarnessState: () => undefined },
    });
    await service.settled();
    await expectFailure(service.refresh(), "invalid_state");
    await expectFailure(service.execute({
      type: "harness.child.open",
      parentPaneId: "pane_rendererparent01",
      childId: child.id,
      expectedParentRevision: 1,
      expectedChildRevision: 1,
    }), "invalid_state");
  });
});
