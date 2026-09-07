import { describe, expect, test } from "bun:test";

import { APP_SOURCE_MARKER_PATH, createAppSourceMarker, parseAppSourceMarker, resolveAppSourceCommit } from "./app-source-marker";

const commit = "a75e7487594ce5b68345ccd3536974a10f7a93ee";
const otherCommit = "576ccd76a6742cd62759ab6176a6a41844846daa";
const expected = {
  generation: 1,
  product: "HRA App",
  repository: { id: 1343008607, path: "hraness/hra" },
  schemaVersion: 1,
  source: { commit },
  version: "0.6.1",
} as const;

describe("app deployment source marker", () => {
  test("preserves the exact existing public identity and serialization", () => {
    expect(APP_SOURCE_MARKER_PATH).toBe(".well-known/hra-app.json");
    const manifest = Object.freeze({ name: "hra", version: "0.6.1" });
    const environment = Object.freeze({ VERCEL: "1", VERCEL_GIT_COMMIT_SHA: commit, HRA_RELEASE_COMMIT: otherCommit });
    expect(createAppSourceMarker(manifest, environment)).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect(parseAppSourceMarker(JSON.parse(createAppSourceMarker(manifest, environment)) as unknown)).toEqual(expected);
    expect(manifest).toEqual({ name: "hra", version: "0.6.1" });
    expect(environment.HRA_RELEASE_COMMIT).toBe(otherCommit);
  });

  test("requires exact provider provenance and preserves local fallback precedence", () => {
    expect(resolveAppSourceCommit({})).toBe("local");
    expect(resolveAppSourceCommit({ HRA_RELEASE_COMMIT: commit })).toBe(commit);
    expect(resolveAppSourceCommit({ VERCEL_GIT_COMMIT_SHA: commit, HRA_RELEASE_COMMIT: otherCommit })).toBe(commit);
    expect(() => resolveAppSourceCommit({ VERCEL: "1", HRA_RELEASE_COMMIT: commit })).toThrow(/Vercel app build requires/u);
    for (const invalid of ["", "local", "main", "abc123", commit.toUpperCase(), `${commit}\n`, ` ${commit}`]) {
      expect(() => resolveAppSourceCommit({ VERCEL: "1", VERCEL_GIT_COMMIT_SHA: invalid })).toThrow();
      expect(() => resolveAppSourceCommit({ HRA_RELEASE_COMMIT: invalid })).toThrow();
    }
  });

  test("accepts only the retained stable and prerelease version contract", () => {
    for (const candidate of ["0.6.1", "0.7.0-beta.1"]) {
      const marker = parseAppSourceMarker(JSON.parse(createAppSourceMarker({ version: candidate }, {})) as unknown);
      expect(marker.version).toBe(candidate);
      expect(marker.source.commit).toBe("local");
    }
    for (const candidate of [undefined, null, 1, "", "1.0.0", "0.6", "v0.6.1", "0.6.1+private"]) {
      expect(() => createAppSourceMarker({ version: candidate }, {})).toThrow();
      expect(() => parseAppSourceMarker({ ...expected, version: candidate })).toThrow();
    }
  });

  test("rejects identity drift, extra fields, malformed records, and foreign commits", () => {
    for (const value of [
      null, [], 1, {}, { ...expected, generation: 2 }, { ...expected, schemaVersion: 2 },
      { ...expected, product: "another app" }, { ...expected, private: "state" },
      { ...expected, repository: { ...expected.repository, id: 1 } },
      { ...expected, repository: { ...expected.repository, path: "other/hra" } },
      { ...expected, repository: { ...expected.repository, extra: true } },
      { ...expected, source: { commit: "main" } }, { ...expected, source: { commit, token: "state" } },
      { ...expected, source: [] },
    ]) expect(() => parseAppSourceMarker(value)).toThrow();
    const parsed = parseAppSourceMarker(expected);
    expect(parsed).toEqual(expected);
    expect(parsed).not.toBe(expected);
    expect(parsed.repository).not.toBe(expected.repository);
    expect(parsed.source).not.toBe(expected.source);
  });
});
