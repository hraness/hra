import { describe, expect, test } from "bun:test";

import { main, renderRemoteSuccess } from "../cli";
import { isUuidV7 } from "../cloud/contracts";
import { LocalDaemonIndeterminateError } from "../daemon/local-transport";
import type { LocalCommand } from "../domain/contracts";
import type { Output } from "./render";

const requestId = "018bcfe5-6800-7000-8000-000000000001";
const privateKeyHeader = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
const privateKeyBodyStart = "c2Vuc2l0aXZlLXByaXZhdGUta2V5LWJvZHk";
const skToken = ["sk", "secretvalue123456789"].join("_");
const reToken = ["re", "secretvalue987654321"].join("_");
const jwt = ["eyJheader123456", "payload123456789", "signature123456"].join(".");
const obscuredBearerToken = "obscured-secret-value-123456789";

function capture(): Readonly<{
  output: Output;
  read(): Readonly<{ stderr: string; stdout: string }>;
}> {
  let stdout = "";
  let stderr = "";
  return {
    output: {
      writeStdout: (value) => { stdout += value; },
      writeStderr: (value) => { stderr += value; },
    },
    read: () => ({ stderr, stdout }),
  };
}

function attackedSyncProjection(): unknown {
  const sentinel = "REMOTE_EVENT_SENTINEL_DO_NOT_RENDER";
  const oversized = `${sentinel}:${"x".repeat(4_300_000)}`;
  const localPath = ["", "Users", "example", "Documents", "private", "state.json"].join("/");
  const bearer = ["Bearer", "secret-token-value-123456789"].join(" ");
  const terminalAttack = "\u001b]0;owned\u0007\u0085\u202etxt";
  return {
    daemon: {
      commandsApplied: 2,
      commandsUnsettled: 1,
      errors: [
        `Could not read ${localPath}`,
        `Authorization failed: ${bearer}`,
        `token=another-secret-token-value`,
        terminalAttack,
        `${privateKeyHeader}\n${privateKeyBodyStart}`,
        `Bearer${terminalAttack} ${obscuredBearerToken}`,
        skToken,
        reToken,
        jwt,
        ...Array.from({ length: 16 }, (_, index) => `bounded error ${String(index)}`),
      ],
      online: true,
      remoteSessions: [{ events: [{ text: oversized }] }],
      sessionsUploaded: 3,
      usageUploaded: 4,
    },
    control: {
      error: `${localPath} ${bearer} ${terminalAttack}`,
      sessions: [{ events: [{ text: oversized }] }],
    },
  };
}

describe("terminal-safe CLI boundaries", () => {
  test("sync now emits one bounded JSON summary without remote or control projections", async () => {
    const captured = capture();
    const calls: LocalCommand[] = [];
    const data = attackedSyncProjection();
    const exitCode = await main(["sync", "now", "--json"], captured.output, {
      callDaemon: async (command) => {
        calls.push(command);
        return { data, ok: true, requestId, version: 1 };
      },
    });

    expect(exitCode).toBe(0);
    expect(calls).toEqual([{ kind: "sync.now" }]);
    expect(captured.read().stderr).toBe("");
    expect(captured.read().stdout.length).toBeLessThan(16_384);
    expect(captured.read().stdout.trim().split("\n")).toHaveLength(1);
    const parsed = JSON.parse(captured.read().stdout) as {
      data: Record<string, unknown> & { errors: string[] };
    };
    expect(Object.keys(parsed.data).sort()).toEqual([
      "commandsApplied",
      "commandsUnsettled",
      "errorCount",
      "errors",
      "errorsOmitted",
      "online",
      "sessionsUploaded",
      "usageUploaded",
    ]);
    expect(parsed.data).toMatchObject({
      commandsApplied: 2,
      commandsUnsettled: 1,
      errorCount: 25,
      errorsOmitted: 9,
      online: true,
      sessionsUploaded: 3,
      usageUploaded: 4,
    });
    expect(parsed.data.errors.join("\n")).toContain("[local-path]");
    expect(parsed.data.errors.join("\n")).toContain("Bearer [redacted]");
    expect(parsed.data.errors.join("\n")).toContain("[redacted-token]");
    expect(parsed.data.errors.join("\n")).toContain("[redacted private key material]");
    expect(parsed.data.errors.join("\n")).toContain("[redacted token-like diagnostic containing terminal controls]");
    expect(parsed.data.errors.join("\n")).toContain("\\u{001b}");
    expect(captured.read().stdout).not.toContain("REMOTE_EVENT_SENTINEL_DO_NOT_RENDER");
    expect(captured.read().stdout).not.toContain("secret-token-value-123456789");
    expect(captured.read().stdout).not.toContain("another-secret-token-value");
    expect(captured.read().stdout).not.toContain(privateKeyHeader);
    expect(captured.read().stdout).not.toContain(privateKeyBodyStart);
    expect(captured.read().stdout).not.toContain(skToken);
    expect(captured.read().stdout).not.toContain(reToken);
    expect(captured.read().stdout).not.toContain(jwt);
    expect(captured.read().stdout).not.toContain(obscuredBearerToken);
    expect(captured.read().stdout).not.toContain("\u001b");
    expect(captured.read().stdout).not.toContain("\u0007");
    expect(captured.read().stdout).not.toContain("\u0085");
    expect(captured.read().stdout).not.toContain("\u202e");
  });

  test("sync now human and failure output stay bounded and redact foreign diagnostics", async () => {
    const human = capture();
    expect(await main(["sync", "now"], human.output, {
      callDaemon: async () => ({
        data: attackedSyncProjection(),
        ok: true,
        requestId,
        version: 1,
      }),
    })).toBe(0);
    expect(human.read().stderr).toBe("");
    expect(human.read().stdout).toContain("Cloud sync: online");
    expect(human.read().stdout).toContain("9 more omitted");
    expect(human.read().stdout.length).toBeLessThan(16_384);
    expect(human.read().stdout).not.toContain("REMOTE_EVENT_SENTINEL_DO_NOT_RENDER");

    const localPath = ["", "private", "tmp", "hra", "secret.json"].join("/");
    const bearer = ["Bearer", "failure-secret-value-123456789"].join(" ");
    const failureSentinel = "FAILURE_DETAILS_SENTINEL_DO_NOT_RENDER";
    const failed = capture();
    expect(await main(["sync", "now", "--json"], failed.output, {
      callDaemon: async () => ({
        error: {
          code: "INTERNAL",
          details: { projection: `${failureSentinel}${"y".repeat(4_300_000)}` },
          message: `Bridge failed at ${localPath}: ${bearer}\u001b]52;c;owned\u0007\u202e`,
        },
        ok: false,
        requestId,
        version: 1,
      }),
    })).toBe(1);
    const failureOutput = failed.read().stdout;
    const parsedFailure = JSON.parse(failureOutput) as { error: { message: string } };
    expect(Object.keys((JSON.parse(failureOutput) as { error: Record<string, unknown> }).error).sort())
      .toEqual(["code", "message"]);
    expect(parsedFailure.error.message).toContain("[redacted token-like diagnostic containing terminal controls]");
    expect(parsedFailure.error.message).not.toContain(localPath);
    expect(failureOutput.length).toBeLessThan(2_048);
    expect(failureOutput).not.toContain(failureSentinel);
    expect(failureOutput).not.toContain("failure-secret-value-123456789");
    expect(failureOutput).not.toContain("\u001b");
    expect(failureOutput).not.toContain("\u0007");
    expect(failureOutput).not.toContain("\u202e");
    expect(failed.read().stderr).toBe("");

    const thrown = capture();
    expect(await main(["sync", "now", "--json"], thrown.output, {
      callDaemon: () => {
        throw new Error(`Control failed at ${localPath} with ${bearer}`);
      },
    })).toBe(1);
    const thrownFailure = JSON.parse(thrown.read().stdout) as { error: { message: string } };
    expect(thrownFailure.error.message).toContain("[local-path]");
    expect(thrownFailure.error.message).toContain("Bearer [redacted]");
    expect(thrown.read().stdout).not.toContain(localPath);
    expect(thrown.read().stdout).not.toContain("failure-secret-value-123456789");
    expect(thrown.read().stderr).toBe("");
  });

  test("remote command status exposes terminal outcomes through a bounded safe projection", async () => {
    const command = {
      commandPublicId: requestId,
      kind: "remote.command",
    } as const;
    const localPath = ["", "Users", "example", "secret.txt"].join("/");
    const bearer = ["Bearer", "remote-secret-token-123456789"].join(" ");
    const attackedResult = `FAILED_AT_${localPath}_${bearer}_\u001b]0;owned\u0007\u202e${"z".repeat(1_000_000)}`;

    const routed = capture();
    const statusCalls: Array<Readonly<{ commandPublicId: string; signal: AbortSignal }>> = [];
    expect(await main(["remote", "command", requestId, "--json"], routed.output, {
      getRemoteCommandStatus: async (input) => {
        statusCalls.push(input);
        return {
          commandPublicId: input.commandPublicId,
          kind: "send",
          resultCode: "LOCAL_CONFLICT",
          sessionPublicId: "session_12345678",
          state: "failed",
          targetDevicePublicId: "device_12345678",
        };
      },
    })).toBe(0);
    expect(statusCalls).toHaveLength(1);
    expect(statusCalls[0]?.commandPublicId).toBe(requestId);
    expect(statusCalls[0]?.signal.aborted).toBe(false);
    expect(JSON.parse(routed.read().stdout)).toMatchObject({
      command: "remote.command",
      data: { resultCode: "LOCAL_CONFLICT", state: "failed" },
      ok: true,
    });
    expect(routed.read().stderr).toBe("");

    const human = capture();
    renderRemoteSuccess(command, {
      commandPublicId: requestId,
      kind: "send",
      resultCode: attackedResult,
      sessionPublicId: "session_12345678",
      state: "ambiguous",
      targetDevicePublicId: "device_12345678",
    }, false, human.output);
    expect(human.read().stdout).toContain("State: ambiguous");
    expect(human.read().stdout).toContain("Result:");
    expect(human.read().stdout.length).toBeLessThan(2_048);
    expect(human.read().stdout).not.toContain("remote-secret-token-123456789");
    expect(human.read().stdout).not.toContain("\u001b");
    expect(human.read().stdout).not.toContain("\u0007");
    expect(human.read().stdout).not.toContain("\u202e");

    const json = capture();
    renderRemoteSuccess(command, {
      commandPublicId: requestId,
      kind: "send",
      resultCode: attackedResult,
      sessionPublicId: "session_12345678",
      state: "failed",
      targetDevicePublicId: "device_12345678",
    }, true, json.output);
    const parsed = JSON.parse(json.read().stdout) as { data: Record<string, unknown> };
    expect(parsed.data).toMatchObject({ state: "failed" });
    expect(Object.keys(parsed.data).sort()).toEqual([
      "commandPublicId",
      "kind",
      "resultCode",
      "sessionPublicId",
      "state",
      "targetDevicePublicId",
    ]);
    expect(json.read().stdout.length).toBeLessThan(2_048);
    expect(json.read().stdout).not.toContain("remote-secret-token-123456789");
    expect(json.read().stderr).toBe("");
  });

  test("projection recovery requires explicit gap acknowledgement and performs no daemon call", async () => {
    let calls = 0;
    const human = capture();
    expect(await main([
      "sync",
      "projection",
      "recover",
      "My local session",
    ], human.output, {
      callDaemon: async () => {
        calls += 1;
        throw new Error("must not be called");
      },
    })).toBe(6);
    expect(calls).toBe(0);
    expect(human.read().stdout).toBe("");
    expect(human.read().stderr).toContain("Projection recovery can preserve an unsynced transcript gap.");
    expect(human.read().stderr).toContain(
      "hra sync projection recover 'My local session' --acknowledge-gap --idempotency-key",
    );

    const json = capture();
    const attackedSelector = "session $(touch nope)\u001b]0;owned\u0007\u202e";
    expect(await main([
      "sync",
      "projection",
      "recover",
      attackedSelector,
      "--json",
    ], json.output, {
      callDaemon: async () => {
        calls += 1;
        throw new Error("must not be called");
      },
    })).toBe(6);
    expect(calls).toBe(0);
    expect(json.read().stderr).toBe("");
    expect(json.read().stdout.length).toBeLessThan(2_048);
    expect(json.read().stdout).not.toContain("\u001b");
    expect(json.read().stdout).not.toContain("\u0007");
    expect(json.read().stdout).not.toContain("\u202e");
    const response = JSON.parse(json.read().stdout) as {
      error: {
        code: string;
        details: {
          acknowledgementRequired: string;
          idempotencyKey: string;
          nextCommand: string;
        };
      };
      ok: boolean;
      version: number;
    };
    expect(response).toMatchObject({
      error: {
        code: "INTERACTION_REQUIRED",
        details: { acknowledgementRequired: "--acknowledge-gap" },
      },
      ok: false,
      version: 1,
    });
    expect(isUuidV7(response.error.details.idempotencyKey)).toBe(true);
    expect(response.error.details.nextCommand).toContain(
      `--idempotency-key ${response.error.details.idempotencyKey} --json`,
    );
  });

  test("projection recovery generates a UUIDv7 before transport and exposes bounded append-only evidence", async () => {
    const calls: Extract<LocalCommand, { kind: "sync.projection-recover" }>[] = [];
    const invoke = async (argv: readonly string[]) => {
      const target = capture();
      const exitCode = await main(argv, target.output, {
        callDaemon: async (command) => {
          if (command.kind !== "sync.projection-recover") {
            throw new Error("Expected projection recovery.");
          }
          calls.push(command);
          return {
            data: {
              boundaryHeadSequence: 41,
              compactHasRecoveryGap: true,
              compactStreamEpoch: 3,
              idempotencyKey: command.idempotencyKey,
              phase: "applied",
              projectionRevision: 19,
              sessionPublicId: "sess_1234567890abcdef1234567890abcdef",
            },
            ok: true,
            requestId,
            version: 1,
          };
        },
      });
      return { exitCode, target };
    };

    const first = await invoke([
      "sync",
      "projection",
      "recover",
      "Exact local label",
      "--acknowledge-gap",
      "--json",
    ]);
    expect(first.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    const key = calls[0]?.idempotencyKey;
    if (!isUuidV7(key)) throw new Error("Expected a generated projection-recovery UUIDv7.");
    expect(calls[0]).toEqual({
      acknowledgeGap: true,
      idempotencyKey: key,
      kind: "sync.projection-recover",
      session: "Exact local label",
    });
    const firstOutput = JSON.parse(first.target.read().stdout) as {
      data: Record<string, unknown> & {
        sameKeyReplay: { command: string; supported: boolean };
      };
    };
    expect(firstOutput.data).toMatchObject({
      boundaryHead: 41,
      gapRemainsVisible: true,
      idempotencyKey: key,
      newEpoch: 3,
      oldEpoch: 2,
      phase: "applied",
      sameKeyReplay: { supported: true },
      session: "sess_1234567890abcdef1234567890abcdef",
    });
    expect(Object.keys(firstOutput.data).sort()).toEqual([
      "boundaryHead",
      "gapRemainsVisible",
      "idempotencyKey",
      "newEpoch",
      "oldEpoch",
      "phase",
      "sameKeyReplay",
      "session",
    ]);
    expect(firstOutput.data.sameKeyReplay.command).toBe(
      `hra sync projection recover sess_1234567890abcdef1234567890abcdef --acknowledge-gap --idempotency-key ${key} --json`,
    );
    expect(first.target.read().stdout).not.toContain("projectionRevision");
    expect(first.target.read().stdout).not.toContain("boundaryTailDigest");

    const replay = await invoke([
      "sync",
      "projection",
      "recover",
      "sess_1234567890abcdef1234567890abcdef",
      "--acknowledge-gap",
      "--idempotency-key",
      key,
      "--json",
    ]);
    expect(replay.exitCode).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.idempotencyKey).toBe(key);
    expect(JSON.parse(replay.target.read().stdout)).toMatchObject({
      data: { idempotencyKey: key, phase: "applied" },
      ok: true,
    });

    const human = await invoke([
      "sync",
      "projection",
      "recover",
      "sess_1234567890abcdef1234567890abcdef",
      "--acknowledge-gap",
      "--idempotency-key",
      key,
    ]);
    expect(human.exitCode).toBe(0);
    expect(human.target.read().stderr).toBe("");
    expect(human.target.read().stdout).toContain("Projection recovery applied for sess_1234567890abcdef1234567890abcdef.");
    expect(human.target.read().stdout).toContain("Epoch: 2 -> 3");
    expect(human.target.read().stdout).toContain("Boundary head: 41");
    expect(human.target.read().stdout).toContain("Gap remains visible: yes");
    expect(human.target.read().stdout).toContain("Encrypted cloud history was preserved");
    expect(human.target.read().stdout).toContain(`Same-key replay: hra sync projection recover sess_1234567890abcdef1234567890abcdef --acknowledge-gap --idempotency-key ${key}`);
  });

  test("projection recovery redacts failures and preserves the generated key after a lost response", async () => {
    const localPath = ["", "Users", "example", "private", "projection.sqlite"].join("/");
    const bearer = ["Bearer", "projection-secret-token-123456789"].join(" ");
    const rejected = capture();
    expect(await main([
      "sync",
      "projection",
      "recover",
      "sess_1234567890abcdef1234567890abcdef",
      "--acknowledge-gap",
      "--json",
    ], rejected.output, {
      callDaemon: async () => ({
        error: {
          code: "INTERNAL",
          details: {
            baselineCompletedTurns: Array.from({ length: 50_000 }, () => "never-render"),
            cachePath: localPath,
          },
          message: `Recovery failed at ${localPath}: ${bearer}\u001b]52;c;owned\u0007\u202e`,
        },
        ok: false,
        requestId,
        version: 1,
      }),
    })).toBe(1);
    const rejectedText = rejected.read().stdout;
    expect(rejectedText.length).toBeLessThan(2_048);
    expect(Object.keys((JSON.parse(rejectedText) as { error: Record<string, unknown> }).error).sort())
      .toEqual(["code", "message"]);
    expect(rejectedText).toContain("[redacted token-like diagnostic containing terminal controls]");
    expect(rejectedText).not.toContain(localPath);
    expect(rejectedText).not.toContain("projection-secret-token-123456789");
    expect(rejectedText).not.toContain("baselineCompletedTurns");
    expect(rejectedText).not.toContain("never-render");
    expect(rejected.read().stderr).toBe("");

    const indeterminate = capture();
    let generatedKey = "";
    expect(await main([
      "sync",
      "projection",
      "recover",
      "sess_1234567890abcdef1234567890abcdef",
      "--acknowledge-gap",
      "--json",
    ], indeterminate.output, {
      callDaemon: (command) => {
        if (command.kind === "sync.projection-recover") {
          generatedKey = command.idempotencyKey;
        }
        throw new LocalDaemonIndeterminateError(
          `Response lost at ${localPath}: ${bearer}\u001b]0;owned\u0007`,
        );
      },
    })).toBe(7);
    const lost = JSON.parse(indeterminate.read().stdout) as {
      error: {
        code: string;
        details: { idempotencyKey: string; nextCommand: string; sameKeyReplay: boolean };
      };
    };
    expect(isUuidV7(generatedKey)).toBe(true);
    expect(lost).toMatchObject({
      error: {
        code: "RECOVERY_REQUIRED",
        details: { idempotencyKey: generatedKey, sameKeyReplay: true },
      },
    });
    expect(lost.error.details.nextCommand).toContain(generatedKey);
    expect(indeterminate.read().stdout.length).toBeLessThan(2_048);
    expect(indeterminate.read().stdout).not.toContain(localPath);
    expect(indeterminate.read().stdout).not.toContain("projection-secret-token-123456789");
    expect(indeterminate.read().stderr).toBe("");
  });

  test("projection recovery reports a terminal rejection without inventing epoch evidence", async () => {
    const target = capture();
    expect(await main([
      "sync",
      "projection",
      "recover",
      "sess_1234567890abcdef1234567890abcdef",
      "--acknowledge-gap",
      "--json",
    ], target.output, {
      callDaemon: async (command) => {
        if (command.kind !== "sync.projection-recover") {
          throw new Error("Expected projection recovery.");
        }
        return {
          data: {
            idempotencyKey: command.idempotencyKey,
            phase: "rejected",
            rejectionCode: "HEAD_CHANGED",
            sessionPublicId: "sess_1234567890abcdef1234567890abcdef",
          },
          ok: true,
          requestId,
          version: 1,
        };
      },
    })).toBe(0);
    const response = JSON.parse(target.read().stdout) as {
      data: Record<string, unknown>;
    };
    expect(response.data).toMatchObject({
      phase: "rejected",
      rejectionCode: "HEAD_CHANGED",
      session: "sess_1234567890abcdef1234567890abcdef",
    });
    expect(Object.keys(response.data).sort()).toEqual([
      "idempotencyKey",
      "phase",
      "rejectionCode",
      "sameKeyReplay",
      "session",
    ]);
    expect(target.read().stdout).not.toContain("oldEpoch");
    expect(target.read().stdout).not.toContain("newEpoch");
    expect(target.read().stdout).not.toContain("boundaryHead");
    expect(target.read().stderr).toBe("");
  });

  test("projection recovery refuses foreign response fields without rendering them", async () => {
    const target = capture();
    const secret = ["sk", "foreignprojectionsecret123456"].join("_");
    expect(await main([
      "sync",
      "projection",
      "recover",
      "sess_1234567890abcdef1234567890abcdef",
      "--acknowledge-gap",
      "--json",
    ], target.output, {
      callDaemon: async (command) => ({
        data: {
          baselineCompletedTurns: [{ providerPayload: secret }],
          boundaryHeadSequence: 41,
          compactHasRecoveryGap: true,
          compactStreamEpoch: 3,
          devicePublicId: "device_private123",
          idempotencyKey: command.kind === "sync.projection-recover"
            ? command.idempotencyKey
            : "invalid",
          phase: "applied",
          projectionRevision: 19,
          sessionPublicId: "sess_1234567890abcdef1234567890abcdef",
          userPublicId: "user_private1234",
        },
        ok: true,
        requestId,
        version: 1,
      }),
    })).toBe(1);
    expect(target.read().stdout).toContain("invalid projection-recovery summary");
    expect(target.read().stdout).not.toContain(secret);
    expect(target.read().stdout).not.toContain("device_private123");
    expect(target.read().stdout).not.toContain("user_private1234");
    expect(target.read().stdout).not.toContain("baselineCompletedTurns");
    expect(target.read().stderr).toBe("");
  });
});
