import { verify, type Bundle } from "sigstore";

type JsonRecord = Record<string, unknown>;

const SLSA_V1 = "https://slsa.dev/provenance/v1";
const FULCIO_GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_BUILD_TYPE = "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
const GITHUB_BUILDER_ID = "https://github.com/actions/runner/github-hosted";
const GITHUB_REPOSITORY_URL = "https://github.com/hraness/hra";
const GITHUB_OIDS = Object.freeze({
  "1.3.6.1.4.1.57264.1.1": "push",
  "1.3.6.1.4.1.57264.1.2": "__SHA__",
  "1.3.6.1.4.1.57264.1.3": "Release",
  "1.3.6.1.4.1.57264.1.4": "hraness/hra",
  "1.3.6.1.4.1.57264.1.5": "__REF__",
});

export type NpmProvenanceAttemptPolicy = "exact" | "same_run_not_later";

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has an unexpected shape.`);
  }
}

export function assertNpmProvenanceBuildIdentity(
  value: unknown,
  input: Readonly<{
    attemptPolicy: NpmProvenanceAttemptPolicy;
    runAttempt: string;
    runId: string;
    sha: string;
    tag: string;
  }>,
): string {
  if (!/^[1-9][0-9]*$/u.test(input.runId) || !/^[1-9][0-9]*$/u.test(input.runAttempt)) {
    throw new Error("npm provenance requires exact workflow run identity.");
  }
  const predicate = record(value, "SLSA predicate");
  const buildDefinition = record(predicate.buildDefinition, "SLSA build definition");
  const externalParameters = record(buildDefinition.externalParameters, "SLSA external parameters");
  const workflow = record(externalParameters.workflow, "SLSA workflow");
  const dependencies = buildDefinition.resolvedDependencies;
  if (
    buildDefinition.buildType !== GITHUB_BUILD_TYPE
    || workflow.repository !== GITHUB_REPOSITORY_URL
    || workflow.path !== ".github/workflows/release.yml"
    || workflow.ref !== `refs/tags/${input.tag}`
    || !Array.isArray(dependencies)
    || dependencies.length !== 1
  ) throw new Error("SLSA provenance has the wrong release workflow identity.");
  const dependency = record(dependencies[0], "SLSA resolved dependency");
  const dependencyDigest = record(dependency.digest, "SLSA resolved dependency digest");
  exactKeys(dependencyDigest, ["gitCommit"], "SLSA resolved dependency digest");
  if (
    dependency.uri !== `git+${GITHUB_REPOSITORY_URL}@refs/tags/${input.tag}`
    || dependencyDigest.gitCommit !== input.sha
  ) throw new Error("SLSA provenance does not bind the exact release ref and commit.");

  const runDetails = record(predicate.runDetails, "SLSA run details");
  const builder = record(runDetails.builder, "SLSA builder");
  const metadata = record(runDetails.metadata, "SLSA run metadata");
  const invocationPrefix = `${GITHUB_REPOSITORY_URL}/actions/runs/${input.runId}/attempts/`;
  if (builder.id !== GITHUB_BUILDER_ID || typeof metadata.invocationId !== "string") {
    throw new Error("SLSA provenance has the wrong GitHub-hosted builder identity.");
  }
  const publishedAttempt = metadata.invocationId.startsWith(invocationPrefix)
    ? metadata.invocationId.slice(invocationPrefix.length)
    : "";
  if (!/^[1-9][0-9]*$/u.test(publishedAttempt)) {
    throw new Error("SLSA provenance is missing exact workflow-run identity.");
  }
  if (
    input.attemptPolicy === "exact"
      ? publishedAttempt !== input.runAttempt
      : BigInt(publishedAttempt) > BigInt(input.runAttempt)
  ) throw new Error("SLSA provenance came from an inadmissible workflow attempt.");
  return publishedAttempt;
}

export async function verifyNpmProvenance(input: Readonly<{
  attemptPolicy: NpmProvenanceAttemptPolicy;
  attestations: unknown;
  integrity: string;
  runId: string;
  runAttempt: string;
  sha: string;
  tag: string;
  tufCachePath: string;
}>): Promise<void> {
  if (!/^[1-9][0-9]*$/u.test(input.runId) || !/^[1-9][0-9]*$/u.test(input.runAttempt)) {
    throw new Error("npm provenance requires exact workflow run identity.");
  }
  if (!/^[0-9a-f]{40}$/u.test(input.sha) || !/^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(input.tag)) {
    throw new Error("npm provenance requires an exact release ref and commit.");
  }
  const root = record(input.attestations, "npm attestations");
  exactKeys(root, ["attestations"], "npm attestations");
  if (!Array.isArray(root.attestations) || root.attestations.length !== 1) {
    throw new Error("npm must expose exactly one provenance attestation.");
  }
  const item = record(root.attestations[0], "npm provenance attestation");
  if (item.predicateType !== SLSA_V1) throw new Error("npm attestation is not exact SLSA v1 provenance.");
  const bundle = record(item.bundle, "npm provenance Sigstore bundle") as Bundle;
  const workflowIdentity = `https://github.com/hraness/hra/.github/workflows/release.yml@refs/tags/${input.tag}`;
  const certificateOIDs = Object.fromEntries(Object.entries(GITHUB_OIDS).map(([oid, expected]) => [
    oid,
    expected === "__SHA__" ? input.sha : expected === "__REF__" ? `refs/tags/${input.tag}` : expected,
  ]));
  await verify(bundle, {
    certificateIdentityURI: workflowIdentity,
    certificateIssuer: FULCIO_GITHUB_ISSUER,
    certificateOIDs,
    ctLogThreshold: 1,
    retry: 0,
    timeout: 10_000,
    tlogThreshold: 1,
    tufCachePath: input.tufCachePath,
  });

  const envelope = record(record(bundle, "Sigstore bundle").dsseEnvelope, "Sigstore DSSE envelope");
  if (envelope.payloadType !== "application/vnd.in-toto+json" || typeof envelope.payload !== "string") {
    throw new Error("npm provenance does not contain one in-toto DSSE payload.");
  }
  const statement = record(JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")), "SLSA statement");
  if (statement._type !== "https://in-toto.io/Statement/v1" || statement.predicateType !== SLSA_V1) {
    throw new Error("npm provenance statement identity is invalid.");
  }
  if (!Array.isArray(statement.subject) || statement.subject.length !== 1) {
    throw new Error("npm provenance must bind exactly one package subject.");
  }
  const subject = record(statement.subject[0], "npm provenance subject");
  const digest = record(subject.digest, "npm provenance subject digest");
  const expectedSha512 = input.integrity.replace(/^sha512-/u, "");
  if (subject.name !== "pkg:npm/%40hraness/hra" || digest.sha512 !== expectedSha512) {
    throw new Error("npm provenance subject does not bind the exact package bytes.");
  }
  const predicate = record(statement.predicate, "SLSA predicate");
  assertNpmProvenanceBuildIdentity(predicate, input);
}
