import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { createHmac } from "node:crypto";

import { hraAttentionResendApiKeyEnvironmentName } from "../convex/resendApiKey";
import { createAttentionKeyInstallTransport } from "./attention-key-install-transport";
import { HRA_CONVEX_PROJECT_ID, HRA_CONVEX_TEAM_ID, type ConvexTarget } from "./convex-target";
import {
  attentionEnvironmentFingerprint,
  attentionKeyInstallCustodySchema,
  attentionKeyInstallIntentSchema,
  parseAttentionKeyInstallationArguments,
  parseAttentionKeyInstallationInput,
  type AttentionKeyInstallationArguments,
} from "./install-hosted-attention-key";
import { canonicalDigest, withSelfDigest } from "./release-evidence";

// Pure parsers and an injected HTTP double only: no operator, filesystem,
// credential reader, target verifier, or provider operation is invoked here.
const token = fc.array(fc.constantFrom(...Array.from("abcdefghijklmnopqrstuvwxyz0123456789")), {
  minLength: 1, maxLength: 32,
}).map((characters) => characters.join(""));
const hex = (length: number) => fc.array(fc.constantFrom(...Array.from("0123456789abcdef")), {
  minLength: length, maxLength: length,
}).map((characters) => characters.join(""));
const targetArbitrary = fc.integer({ min: 7_000_000, max: 8_000_000 }).map((deploymentId): ConvexTarget => ({
  deploymentId,
  deploymentName: `synthetic-target-${deploymentId}`,
  deploymentUrl: `https://synthetic-target-${deploymentId}.convex.cloud`,
  projectId: HRA_CONVEX_PROJECT_ID,
  teamId: HRA_CONVEX_TEAM_ID,
}));
const keyArbitrary = token.map((suffix) => `re_synthetic_${suffix}`);
const whitespace = fc.array(fc.constantFrom(" ", "\t", "\r", "\n"), { maxLength: 8 })
  .map((characters) => characters.join(""));
const expectValue = (actual: unknown, expected: unknown): void => { expect(actual).toEqual(expected); };
const changedDigest = (digest: string): string => `${digest.startsWith("0") ? "1" : "0"}${digest.slice(1)}`;
const argumentPairs = (value: AttentionKeyInstallationArguments): string[][] => [
  ["--deployment", value.target.deploymentName], ["--deployment-url", value.target.deploymentUrl],
  ["--team-id", String(value.target.teamId)], ["--project-id", String(value.target.projectId)],
  ["--deployment-id", String(value.target.deploymentId)], ["--phase", value.phase],
  ["--source-commit", value.sourceCommit], ["--deploy-evidence", value.deployEvidencePath],
  ["--preparation-evidence", value.preparationEvidencePath],
  ["--custody-attestation", value.custodyAttestationPath], ["--evidence-directory", value.evidenceDirectory],
];
const argumentOrder = fc.shuffledSubarray(Array.from({ length: 11 }, (_, index) => index), {
  minLength: 11, maxLength: 11,
});
const environmentArbitrary = fc.uniqueArray(fc.record({
  name: token.map((suffix) => `SYNTHETIC_${suffix}`),
  value: fc.string({ maxLength: 64 }),
}), { selector: (entry) => entry.name, minLength: 2, maxLength: 8 });
const permutedEnvironment = environmentArbitrary.chain((entries) => fc.tuple(
  fc.constant(entries), fc.shuffledSubarray(entries, { minLength: entries.length, maxLength: entries.length }),
));

// Deliberately duplicate one root member; retain the original raw JSON suffix,
// including any nested braces or duplicate spellings, without reserializing it.
function duplicateLeadingAttentionKey(document: string, key: string): string {
  const prefix = `{"attentionResendApiKey":${JSON.stringify(key)},`;
  if (!document.startsWith(prefix) || !document.endsWith("}")) {
    throw new Error("SYNTHETIC_ATTENTION_INPUT_PREFIX_INVALID");
  }
  return prefix + document.slice(1);
}

describe("attention key installation synthetic property contracts", () => {
  test("duplicate-key corruption changes only the checked leading root member", () => {
    const document = '{"attentionResendApiKey":"re_synthetic_{key}","nested":{"attentionResendApiKey":"inner"},"raw":"{}","raw":"{kept}"}';
    const corrupted = duplicateLeadingAttentionKey(document, "re_synthetic_{key}");
    const prefix = '{"attentionResendApiKey":"re_synthetic_{key}",';
    expect(corrupted).toBe('{"attentionResendApiKey":"re_synthetic_{key}","attentionResendApiKey":"re_synthetic_{key}","nested":{"attentionResendApiKey":"inner"},"raw":"{}","raw":"{kept}"}');
    expect(corrupted.slice(prefix.length)).toBe(document.slice(1));
    for (const invalid of ["[]", ` ${document}`, document.slice(0, -1), '{"other":"re_synthetic_{key}"}']) {
      expect(() => duplicateLeadingAttentionKey(invalid, "re_synthetic_{key}")).toThrow("SYNTHETIC_ATTENTION_INPUT_PREFIX_INVALID");
    }
    expect(() => duplicateLeadingAttentionKey(document, "different")).toThrow("SYNTHETIC_ATTENTION_INPUT_PREFIX_INVALID");
  });

  test("protected-input roundtrips preserve exact values and refuse ambiguous or out-of-scope spellings", () => {
    fc.assert(fc.property(targetArbitrary, keyArbitrary, token, whitespace, (target, attentionResendApiKey, suffix, space) => {
      const input = { attentionResendApiKey, convexDeploymentAdminKey: `prod:${target.deploymentName}|synthetic_admin_token_${suffix}` };
      const document = JSON.stringify(input);
      const parsed = parseAttentionKeyInstallationInput(`${space}${JSON.stringify(input, null, "\t")}${space}`, target);
      expectValue(parsed, input);
      expectValue(parseAttentionKeyInstallationInput(JSON.stringify(parsed), target), input);
      for (const invalid of [
        JSON.stringify({ ...input, extra: suffix }),
        duplicateLeadingAttentionKey(document, attentionResendApiKey),
        JSON.stringify({ convexDeploymentAdminKey: input.convexDeploymentAdminKey }),
        JSON.stringify({ ...input, attentionResendApiKey: `${attentionResendApiKey} ` }),
        JSON.stringify({ ...input, convexDeploymentAdminKey: `dev:${target.deploymentName}|synthetic_admin_token_${suffix}` }),
        JSON.stringify({ ...input, convexDeploymentAdminKey: `prod:other-target-1|synthetic_admin_token_${suffix}` }),
        document.replace('"attentionResendApiKey"', '"attentionResendApi\\u004bey"'),
      ]) expect(() => parseAttentionKeyInstallationInput(invalid, target)).toThrow("input_invalid");
    }), { seed: 68151, numRuns: 200 });
  });

  test("argument pair permutations roundtrip without mutation and reject missing, duplicate or unknown flags", () => {
    fc.assert(fc.property(targetArbitrary, hex(40), token, fc.constantFrom("install", "reconcile"), argumentOrder,
      (target, sourceCommit, suffix, phase, order) => {
        const base = `/synthetic/attention-${suffix}`;
        const expected: AttentionKeyInstallationArguments = {
          target, sourceCommit, phase, custodyAttestationPath: `${base}/custody.json`,
          deployEvidencePath: `${base}/deploy.json`, preparationEvidencePath: `${base}/prepare.json`,
          evidenceDirectory: `${base}/evidence`,
        };
        const pairs = argumentPairs(expected);
        const arguments_ = Object.freeze(order.flatMap((index) => {
          const pair = pairs[index];
          if (pair === undefined) throw new Error("SYNTHETIC_ARGUMENT_ORDER_INVALID");
          return pair;
        }));
        const before = JSON.stringify(arguments_);
        const parsed = parseAttentionKeyInstallationArguments(arguments_);
        expectValue(parsed, expected);
        expectValue(parseAttentionKeyInstallationArguments(argumentPairs(parsed).flat()), expected);
        expect(JSON.stringify(arguments_)).toBe(before);
        for (const [index, pair] of pairs.entries()) {
          expect(() => parseAttentionKeyInstallationArguments([...arguments_, ...pair])).toThrow();
          expect(() => parseAttentionKeyInstallationArguments(pairs.filter((_, candidate) => candidate !== index).flat())).toThrow();
        }
        expect(() => parseAttentionKeyInstallationArguments([...arguments_, "--unknown", suffix])).toThrow();
        expect(() => parseAttentionKeyInstallationArguments([...arguments_, "--phase"])).toThrow();
        expect(() => parseAttentionKeyInstallationArguments(argumentPairs({
          ...expected, evidenceDirectory: expected.deployEvidencePath,
        }).flat())).toThrow("usage_invalid");
      }), { seed: 68152, numRuns: 200 });
  });

  test("custody and intent schemas retain exact structural roundtrips and reject closed-contract mutations", () => {
    fc.assert(fc.property(targetArbitrary, hex(40), hex(64), fc.uuid(),
      fc.integer({ min: 0, max: 1_000_000 }), fc.integer({ min: 1, max: 900_000 }),
      (target, sourceCommit, digest, operationId, issuedAtMs, duration) => {
        const custody = withSelfDigest({
          authorityPremise: "operational_custody_attested", candidateDeployDigest: digest,
          competingWritersQuiesced: { ci: true, cli: true, dashboard: true, delegated: true },
          evidenceDirectory: "/synthetic/attention/evidence", evidenceDirectorySharedAndRetained: true,
          expiresAtMs: issuedAtMs + duration, intendedKeyDigest: digest, issuedAtMs,
          kind: "hosted-attention-key-custody", operationId, preparationDigest: digest,
          schemaVersion: 1, sourceCommit, target, targetDigest: canonicalDigest(target),
        });
        const parsed = attentionKeyInstallCustodySchema.parse(custody);
        expectValue(parsed, custody);
        expectValue(attentionKeyInstallCustodySchema.parse(JSON.parse(JSON.stringify(parsed)) as unknown), custody);
        for (const invalid of [
          { ...custody, extra: true }, { ...custody, expiresAtMs: issuedAtMs },
          { ...custody, expiresAtMs: issuedAtMs + 900_001 },
          { ...custody, targetDigest: changedDigest(custody.targetDigest) },
          { ...custody, target: { ...target, extra: true } },
          ...["ci", "cli", "dashboard", "delegated"].map((writer) => ({
            ...custody, competingWritersQuiesced: { ...custody.competingWritersQuiesced, [writer]: false },
          })),
        ]) expect(attentionKeyInstallCustodySchema.safeParse(invalid).success).toBe(false);
        const intent = withSelfDigest({
          authorityPremise: "operational_custody_attested", candidateDeployDigest: digest,
          custodyDigest: parsed.selfDigest, intendedKeyDigest: digest, kind: "hosted-attention-key-install-intent",
          nonAttentionEnvironmentDigest: digest, operationId, preparationDigest: digest,
          schemaVersion: 1, sourceCommit, target, targetDigest: parsed.targetDigest,
        });
        const parsedIntent = attentionKeyInstallIntentSchema.parse(intent);
        expectValue(parsedIntent, intent);
        expectValue(attentionKeyInstallIntentSchema.parse(JSON.parse(JSON.stringify(parsedIntent)) as unknown), intent);
        for (const invalid of [
          { ...intent, extra: true }, { ...intent, authorityPremise: "provider_cas" },
          { ...intent, kind: "hosted-attention-key-custody" }, { ...intent, schemaVersion: 2 },
          { ...intent, nonAttentionEnvironmentDigest: `${digest}0` },
        ]) expect(attentionKeyInstallIntentSchema.safeParse(invalid).success).toBe(false);
        // Schema parsing is not filesystem digest verification or evidence of
        // real custody; those operations are deliberately not invoked here.
      }), { seed: 68153, numRuns: 200 });
  });

  test("fingerprints are permutation-invariant, exactly framed and separate names, values, targets and keys", () => {
    fc.assert(fc.property(permutedEnvironment, targetArbitrary, keyArbitrary, ([entries, permutation], target, key) => {
      const before = JSON.stringify(entries);
      const fingerprint = attentionEnvironmentFingerprint(entries, target, key);
      const ordered = [...entries].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
      // Independently serialize the documented, lexically ordered field set.
      const expected = createHmac("sha256", key).update("hra-attention-environment-fingerprint-v1\0", "utf8")
        .update(JSON.stringify({ entries: ordered.map(({ name, value }) => ({ name, value })), target }), "utf8").digest("hex");
      expect(fingerprint).toBe(expected);
      expect(attentionEnvironmentFingerprint(permutation, target, key)).toBe(fingerprint);
      expect(attentionEnvironmentFingerprint([...permutation, {
        name: hraAttentionResendApiKeyEnvironmentName, value: `${key}_different`,
      }], target, key)).toBe(fingerprint);
      expect(attentionEnvironmentFingerprint(entries.map((entry, index) => index === 0
        ? { ...entry, name: `${entry.name}_CHANGED` } : entry), target, key)).not.toBe(fingerprint);
      expect(attentionEnvironmentFingerprint(entries.map((entry, index) => index === 0
        ? { ...entry, value: `${entry.value}\0` } : entry), target, key)).not.toBe(fingerprint);
      expect(attentionEnvironmentFingerprint(entries.slice(1), target, key)).not.toBe(fingerprint);
      expect(attentionEnvironmentFingerprint(entries, { ...target, deploymentId: target.deploymentId + 1 }, key)).not.toBe(fingerprint);
      expect(attentionEnvironmentFingerprint(entries, target, `${key}_different`)).not.toBe(fingerprint);
      expect(JSON.stringify(entries)).toBe(before);
    }), { seed: 68154, numRuns: 200 });
  });

  test("mock environment decoding preserves generated strings and refuses malformed rows without retries", async () => {
    await fc.assert(fc.asyncProperty(environmentArbitrary, targetArbitrary, async (entries, target) => {
      const decode = async (response: unknown) => {
        let requests = 0;
        const transport = createAttentionKeyInstallTransport({
          adminKey: "synthetic-admin", attentionKey: "re_synthetic_attention", target,
          fetcher: async (input) => {
            requests += 1;
            if (!(input instanceof URL)) throw new Error("SYNTHETIC_QUERY_URL_REQUIRED");
            expect(input.href).toBe(`${target.deploymentUrl}/api/query`);
            return Response.json(response);
          },
        });
        try { return await transport.readEnvironment(); }
        finally { expect(requests).toBe(1); }
      };
      expectValue(await decode({ status: "success", value: entries }), entries);
      const first = entries[0];
      if (first === undefined) throw new Error("SYNTHETIC_ENVIRONMENT_EMPTY");
      for (const malformed of [
        [...entries, first], [{ ...first, value: null }], [{ ...first, name: `1${first.name}` }],
        [{ ...first, extra: true }], null,
      ]) await expect(decode({ status: "success", value: malformed })).rejects.toThrow();
    }), { seed: 68155, numRuns: 100 });
  });
});
