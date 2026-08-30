import { resolve } from "node:path";

type JsonRecord = Record<string, unknown>;

const SLSA_V1 = "https://slsa.dev/provenance/v1";
const NPM_PUBLISH_V01 = "https://github.com/npm/attestation/tree/main/specs/publish/v0.1";
const FULCIO_GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_BUILD_TYPE = "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
const GITHUB_BUILDER_ID = "https://github.com/actions/runner/github-hosted";
const GITHUB_REPOSITORY_URL = "https://github.com/hraness/hra";
const GITHUB_REPOSITORY_ID = "1343008607";
const MAXIMUM_DSSE_PAYLOAD_BYTES = 256 * 1_024;
const MAXIMUM_CRYPTO_INPUT_BYTES = 1024 * 1_024;
const MAXIMUM_CRYPTO_OUTPUT_BYTES = 8 * 1_024;

export type NpmProvenanceAttemptPolicy = "exact" | "same_run_not_later";

const CRYPTO_RUNTIME_ENVIRONMENT = Object.freeze([
  "HOME", "LANG", "LC_ALL", "LC_CTYPE", "NODE_EXTRA_CA_CERTS", "PATH",
  "SSL_CERT_FILE", "TEMP", "TMP", "TMPDIR", "TZ",
] as const);

export function npmCryptoEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  if (source.PATH === undefined || source.PATH.length === 0) {
    throw new Error("npm cryptographic verification requires an explicit runtime PATH.");
  }
  return Object.fromEntries(CRYPTO_RUNTIME_ENVIRONMENT.flatMap((name) => {
    const value = source[name];
    return value === undefined ? [] : [[name, value]];
  }));
}

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

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function decodeStatement(bundle: JsonRecord, label: string): JsonRecord {
  const envelope = record(bundle.dsseEnvelope, `${label} DSSE envelope`);
  if (envelope.payloadType !== "application/vnd.in-toto+json" || typeof envelope.payload !== "string") {
    throw new Error(`${label} does not contain one in-toto DSSE payload.`);
  }
  const bytes = Buffer.from(envelope.payload, "base64");
  if (
    bytes.byteLength === 0
    || bytes.byteLength > MAXIMUM_DSSE_PAYLOAD_BYTES
    || bytes.toString("base64") !== envelope.payload
  ) throw new Error(`${label} DSSE payload is not canonical bounded base64.`);
  try {
    return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), `${label} statement`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${label} statement`)) throw error;
    throw new Error(`${label} DSSE payload is not canonical UTF-8 JSON.`);
  }
}

export function npmProvenanceSignerPolicy(tag: string, sha: string, invocation: string): Readonly<{
  certificateIdentityURI: string;
  certificateIssuer: string;
  certificateOIDs: Readonly<Record<string, string>>;
}> {
  if (
    !/^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(tag)
    || !/^[0-9a-f]{40}$/u.test(sha)
    || !/^https:\/\/github\.com\/hraness\/hra\/actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*$/u.test(invocation)
  ) throw new Error("npm provenance signer coordinates are invalid.");
  const ref = `refs/tags/${tag}`;
  const identity = `${GITHUB_REPOSITORY_URL}/.github/workflows/release.yml@${ref}`;
  return Object.freeze({
    certificateIdentityURI: `^${escapeRegularExpression(identity)}$`,
    certificateIssuer: FULCIO_GITHUB_ISSUER,
    certificateOIDs: Object.freeze({
      "1.3.6.1.4.1.57264.1.2": "push",
      "1.3.6.1.4.1.57264.1.3": sha,
      "1.3.6.1.4.1.57264.1.5": "hraness/hra",
      "1.3.6.1.4.1.57264.1.6": ref,
      "1.3.6.1.4.1.57264.1.11": "github-hosted",
      "1.3.6.1.4.1.57264.1.12": GITHUB_REPOSITORY_URL,
      "1.3.6.1.4.1.57264.1.13": sha,
      "1.3.6.1.4.1.57264.1.14": ref,
      "1.3.6.1.4.1.57264.1.15": GITHUB_REPOSITORY_ID,
      "1.3.6.1.4.1.57264.1.18": identity,
      "1.3.6.1.4.1.57264.1.19": sha,
      "1.3.6.1.4.1.57264.1.20": "push",
      "1.3.6.1.4.1.57264.1.21": invocation,
      "1.3.6.1.4.1.57264.1.22": "public",
      "1.3.6.1.4.1.57264.1.24": `repo:hraness/hra:ref:${ref}`,
    }),
  });
}

export function assertNpmProvenanceBuildIdentity(
  value: unknown,
  input: Readonly<{
    attemptPolicy: NpmProvenanceAttemptPolicy;
    maximumAttempt?: string;
    runAttempt: string;
    runId: string;
    sha: string;
    tag: string;
  }>,
): string {
  if (
    !/^[1-9][0-9]*$/u.test(input.runId)
    || !/^[1-9][0-9]*$/u.test(input.runAttempt)
    || (input.maximumAttempt !== undefined && (
      !/^[1-9][0-9]*$/u.test(input.maximumAttempt)
      || BigInt(input.maximumAttempt) > BigInt(input.runAttempt)
    ))
  ) {
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
      : BigInt(publishedAttempt) > BigInt(input.maximumAttempt ?? input.runAttempt)
  ) throw new Error("SLSA provenance came from an inadmissible workflow attempt.");
  return publishedAttempt;
}

export function assertNpmProvenanceSubject(
  value: unknown,
  input: Readonly<{ integrity: string; tag: string }>,
): void {
  if (!/^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(input.tag)) {
    throw new Error("npm provenance requires an exact release tag.");
  }
  const integrity = /^sha512-([A-Za-z0-9+/]{86}==)$/u.exec(input.integrity);
  const encodedIntegrity = integrity?.[1];
  const integrityBytes = encodedIntegrity === undefined
    ? undefined
    : Buffer.from(encodedIntegrity, "base64");
  if (
    integrityBytes === undefined
    || integrityBytes.byteLength !== 64
    || integrityBytes.toString("base64") !== encodedIntegrity
  ) throw new Error("npm provenance requires one canonical SHA-512 integrity.");

  const statement = record(value, "SLSA statement");
  if (!Array.isArray(statement.subject) || statement.subject.length !== 1) {
    throw new Error("npm provenance must bind exactly one package subject.");
  }
  const subject = record(statement.subject[0], "npm provenance subject");
  exactKeys(subject, ["digest", "name"], "npm provenance subject");
  const digest = record(subject.digest, "npm provenance subject digest");
  exactKeys(digest, ["sha512"], "npm provenance subject digest");
  if (
    subject.name !== `pkg:npm/%40hraness/hra@${input.tag.slice(1)}`
    || digest.sha512 !== integrityBytes.toString("hex")
  ) throw new Error("npm provenance subject does not bind the exact package bytes.");
}

type NpmAttestationItem = Readonly<{
  bundle: JsonRecord;
  predicateType: string;
  signedAccessSignatureUrl: "";
}>;

export function selectNpmProvenanceAttestations(value: unknown): Readonly<{
  provenance: NpmAttestationItem;
  publish?: NpmAttestationItem;
}> {
  const root = record(value, "npm attestations");
  exactKeys(root, ["attestations"], "npm attestations");
  if (!Array.isArray(root.attestations) || root.attestations.length < 1 || root.attestations.length > 2) {
    throw new Error("npm must expose a bounded expected attestation set.");
  }
  const items = root.attestations.map((candidate, index): NpmAttestationItem => {
    const item = record(candidate, `npm attestation ${String(index + 1)}`);
    exactKeys(item, ["bundle", "predicateType", "signedAccessSignatureUrl"], `npm attestation ${String(index + 1)}`);
    if (
      (item.predicateType !== SLSA_V1 && item.predicateType !== NPM_PUBLISH_V01)
      || item.signedAccessSignatureUrl !== ""
    ) {
      throw new Error("npm exposed an unexpected attestation predicate.");
    }
    return Object.freeze({
      bundle: record(item.bundle, `npm attestation ${String(index + 1)} bundle`),
      predicateType: item.predicateType,
      signedAccessSignatureUrl: "",
    });
  });
  const provenance = items.filter((item) => item.predicateType === SLSA_V1);
  const publish = items.filter((item) => item.predicateType === NPM_PUBLISH_V01);
  if (provenance.length !== 1 || publish.length > 1) {
    throw new Error("npm must expose exactly one SLSA v1 provenance attestation.");
  }
  const exactProvenance = provenance[0];
  if (exactProvenance === undefined) {
    throw new Error("npm must expose exactly one SLSA v1 provenance attestation.");
  }
  const registryPublish = publish[0];
  return Object.freeze({
    provenance: exactProvenance,
    ...(registryPublish === undefined ? {} : { publish: registryPublish }),
  });
}

export function assertNpmPublishAttestation(
  bundle: JsonRecord,
  input: Readonly<{ integrity: string; tag: string }>,
): void {
  const statement = decodeStatement(bundle, "npm registry publish attestation");
  if (
    statement._type !== "https://in-toto.io/Statement/v0.1"
    || statement.predicateType !== NPM_PUBLISH_V01
    || !Array.isArray(statement.subject)
    || statement.subject.length !== 1
  ) throw new Error("npm registry publish statement identity is invalid.");
  const subject = record(statement.subject[0], "npm registry publish subject");
  exactKeys(subject, ["digest", "name"], "npm registry publish subject");
  const digest = record(subject.digest, "npm registry publish subject digest");
  exactKeys(digest, ["sha512"], "npm registry publish subject digest");
  const integrity = /^sha512-([A-Za-z0-9+/]{86}==)$/u.exec(input.integrity)?.[1];
  const expectedDigest = integrity === undefined ? undefined : Buffer.from(integrity, "base64").toString("hex");
  const predicate = record(statement.predicate, "npm registry publish predicate");
  exactKeys(predicate, ["name", "registry", "version"], "npm registry publish predicate");
  if (
    subject.name !== `pkg:npm/%40hraness/hra@${input.tag.slice(1)}`
    || digest.sha512 !== expectedDigest
    || predicate.name !== "@hraness/hra"
    || predicate.version !== input.tag.slice(1)
    || predicate.registry !== "https://registry.npmjs.org"
  ) throw new Error("npm registry publish attestation does not bind the exact package bytes.");
}

export function npmRegistryKeySelector(value: unknown): (hint: string) => string | undefined {
  const root = record(value, "npm registry keys");
  exactKeys(root, ["keys"], "npm registry keys");
  if (!Array.isArray(root.keys) || root.keys.length < 1 || root.keys.length > 8) {
    throw new Error("npm registry key set is not bounded.");
  }
  const keys = new Map<string, string>();
  for (const candidate of root.keys) {
    const key = record(candidate, "npm registry key");
    exactKeys(key, ["expires", "key", "keyid", "keytype", "scheme"], "npm registry key");
    if (
      typeof key.keyid !== "string"
      || !/^SHA256:[A-Za-z0-9+/]{43}$/u.test(key.keyid)
      || key.keytype !== "ecdsa-sha2-nistp256"
      || key.scheme !== "ecdsa-sha2-nistp256"
      || typeof key.key !== "string"
      || (key.expires !== null && (typeof key.expires !== "string" || Number.isNaN(Date.parse(key.expires))))
      || keys.has(key.keyid)
    ) throw new Error("npm registry key is invalid or duplicated.");
    const keyIdDigest = Buffer.from(`${key.keyid.slice("SHA256:".length)}=`, "base64");
    if (
      keyIdDigest.byteLength !== 32
      || keyIdDigest.toString("base64").slice(0, -1) !== key.keyid.slice("SHA256:".length)
    ) throw new Error("npm registry key ID is not canonical base64url-free SHA-256.");
    const bytes = Buffer.from(key.key, "base64");
    if (bytes.byteLength === 0 || bytes.toString("base64") !== key.key) {
      throw new Error("npm registry key is not canonical base64.");
    }
    const encoded = bytes.toString("base64").match(/.{1,64}/gu)?.join("\n");
    if (encoded === undefined) throw new Error("npm registry key is invalid.");
    keys.set(key.keyid, `-----BEGIN PUBLIC KEY-----\n${encoded}\n-----END PUBLIC KEY-----\n`);
  }
  return (hint: string) => keys.get(hint);
}

async function boundedProcessOutput(
  stream: ReadableStream<Uint8Array>,
  kill: () => void,
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > MAXIMUM_CRYPTO_OUTPUT_BYTES) {
        kill();
        throw new Error("npm cryptographic verification output exceeded its bound.");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

async function verifyCryptographicBundle(
  mode: "npm-publish" | "slsa",
  input: unknown,
  arguments_: readonly string[],
): Promise<void> {
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_CRYPTO_INPUT_BYTES) {
    throw new Error("npm cryptographic verification input exceeded its bound.");
  }
  const child = Bun.spawn([
    "node", resolve(import.meta.dir, "verify-npm-provenance-crypto.mjs"), mode, ...arguments_,
  ], {
    env: npmCryptoEnvironment(),
    stderr: "pipe",
    stdin: "pipe",
    stdout: "pipe",
  });
  await child.stdin.write(serialized);
  await child.stdin.end();
  const kill = () => child.kill(9);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      kill();
      reject(new Error("npm cryptographic verification timed out."));
    }, 60_000);
  });
  try {
    const [exitCode, stdout, stderr] = await Promise.race([
      Promise.all([
        child.exited,
        boundedProcessOutput(child.stdout, kill),
        boundedProcessOutput(child.stderr, kill),
      ]),
      timeout,
    ]);
    if (exitCode !== 0 || stdout.toString("utf8") !== "verified\n" || stderr.byteLength !== 0) {
      throw new Error("npm cryptographic verification failed without exposing provider output.");
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function verifyNpmProvenance(input: Readonly<{
  attemptPolicy: NpmProvenanceAttemptPolicy;
  attestations: unknown;
  integrity: string;
  maximumAttempt?: string;
  registryKeys: unknown;
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
  const selected = selectNpmProvenanceAttestations(input.attestations);
  const statement = decodeStatement(selected.provenance.bundle, "npm SLSA provenance");
  if (statement._type !== "https://in-toto.io/Statement/v1" || statement.predicateType !== SLSA_V1) {
    throw new Error("npm provenance statement identity is invalid.");
  }
  assertNpmProvenanceSubject(statement, input);
  const predicate = record(statement.predicate, "SLSA predicate");
  const publishedAttempt = assertNpmProvenanceBuildIdentity(predicate, input);
  const invocation = `${GITHUB_REPOSITORY_URL}/actions/runs/${input.runId}/attempts/${publishedAttempt}`;
  npmProvenanceSignerPolicy(input.tag, input.sha, invocation);
  await verifyCryptographicBundle("slsa", { bundle: selected.provenance.bundle }, [
    input.tag, input.sha, invocation, input.tufCachePath,
  ]);
  if (selected.publish !== undefined) {
    assertNpmPublishAttestation(selected.publish.bundle, input);
    npmRegistryKeySelector(input.registryKeys);
    await verifyCryptographicBundle("npm-publish", {
      bundle: selected.publish.bundle,
      registryKeys: input.registryKeys,
    }, [input.tufCachePath]);
  }
}
