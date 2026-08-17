import { describe, expect, test } from "bun:test";

import {
  candidateMutationBody,
  DEV_APPLY_SCHEMA,
  developmentReloadRequest,
  parseDevelopmentReloadResponse,
  parseDevStatusEnvelope,
} from "./protocol";

const sessionId = "a".repeat(64);
const candidateId = "b".repeat(64);

describe("malleable development protocol", () => {
  test("parses the exact bounded launcher status", () => {
    const parsed = parseDevStatusEnvelope({
      schema: "hra-dev-status/v1",
      sessionId,
      authority: "launcher",
      revision: 7,
      state: "staged",
      target: "gateway",
      changeCount: 3,
      candidateId,
    });
    expect(String(parsed.sessionId)).toBe(sessionId);
    expect(String(parsed.candidateId)).toBe(candidateId);
    expect(parsed.state).toBe("staged");
  });

  test("rejects extra fields, inconsistent candidates, and UI-only authority escalation", () => {
    const current = {
      schema: "hra-dev-status/v1",
      sessionId,
      authority: "uiOnly",
      revision: 0,
      state: "current",
      target: "none",
      changeCount: 0,
      candidateId: null,
    } as const;
    expect(parseDevStatusEnvelope(current).authority).toBe("uiOnly");
    expect(() => parseDevStatusEnvelope({ ...current, path: "/private/source" })).toThrow();
    expect(() => parseDevStatusEnvelope({ ...current, state: "staged", candidateId })).toThrow();
    expect(() => parseDevStatusEnvelope({
      ...current,
      sessionId: sessionId.toUpperCase(),
    })).toThrow();
  });

  test("builds the strict candidate-bound Native and coordinator requests", () => {
    expect(developmentReloadRequest(candidateId)).toEqual({
      version: 1,
      mode: "developmentReload",
      candidateId,
    });
    expect(JSON.parse(candidateMutationBody(
      DEV_APPLY_SCHEMA,
      sessionId,
      candidateId,
    ))).toEqual({
      schema: DEV_APPLY_SCHEMA,
      sessionId,
      candidateId,
    });
  });

  test("requires an accepted reload to advance to one exact generation", () => {
    expect(parseDevelopmentReloadResponse({
      version: 1,
      mode: "developmentReload",
      status: "accepted",
      candidateId,
      currentGeneration: 4,
      nextGeneration: 5,
    })).toEqual({
      version: 1,
      mode: "developmentReload",
      status: "accepted",
      candidateId,
      currentGeneration: 4,
      nextGeneration: 5,
    });
    expect(() => parseDevelopmentReloadResponse({
      version: 1,
      mode: "developmentReload",
      status: "accepted",
      candidateId,
      currentGeneration: 4,
      nextGeneration: 4,
    })).toThrow();
    expect(() => parseDevelopmentReloadResponse({
      version: 1,
      mode: "developmentReload",
      status: "accepted",
      candidateId,
      currentGeneration: 4,
      nextGeneration: 6,
    })).toThrow();
    expect(parseDevelopmentReloadResponse({
      version: 1,
      mode: "developmentReload",
      status: "busy",
      candidateId,
      currentGeneration: 4,
      nextGeneration: null,
    }).status).toBe("busy");
  });
});
