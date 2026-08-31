import { Buffer } from "node:buffer";
import process from "node:process";
import { pathToFileURL } from "node:url";

const GITHUB_REPOSITORY_OWNER = "hraness";
const GITHUB_REPOSITORY_OWNER_ID = "307125679";
const GITHUB_REPOSITORY_NAME = "hra";
const GITHUB_REPOSITORY_ID = "1343008607";
const GITHUB_REPOSITORY = `${GITHUB_REPOSITORY_OWNER}/${GITHUB_REPOSITORY_NAME}`;
const GITHUB_REPOSITORY_URL = `https://github.com/${GITHUB_REPOSITORY}`;
const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const MAXIMUM_INPUT_BYTES = 1024 * 1_024;
const SHA = /^[0-9a-f]{40}$/u;
const STABLE_TAG = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const INVOCATION = /^https:\/\/github\.com\/hraness\/hra\/actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*$/u;

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new Error(`${label} has unexpected fields.`);
  }
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function canonicalAsciiDerUtf8String(value) {
  if (!/^[\x20-\x7e]{1,127}$/u.test(value)) {
    throw new Error("Fulcio UTF8String claim must be bounded nonempty canonical ASCII.");
  }
  return `${String.fromCharCode(0x0c, value.length)}${value}`;
}

export function releaseSignerIdentity(tag, sha, invocation) {
  if (!STABLE_TAG.test(tag) || !SHA.test(sha) || !INVOCATION.test(invocation)) {
    throw new Error("npm provenance signer coordinates are invalid.");
  }
  const ref = `refs/tags/${tag}`;
  const identity = `${GITHUB_REPOSITORY_URL}/.github/workflows/release.yml@${ref}`;
  const der = canonicalAsciiDerUtf8String;
  return Object.freeze({
    identity,
    options: Object.freeze({
      certificateIdentityURI: `^${escapeRegularExpression(identity)}$`,
      certificateIssuer: GITHUB_OIDC_ISSUER,
      certificateOIDs: Object.freeze({
        "1.3.6.1.4.1.57264.1.2": "push",
        "1.3.6.1.4.1.57264.1.3": sha,
        "1.3.6.1.4.1.57264.1.5": GITHUB_REPOSITORY,
        "1.3.6.1.4.1.57264.1.6": ref,
        "1.3.6.1.4.1.57264.1.11": der("github-hosted"),
        "1.3.6.1.4.1.57264.1.12": der(GITHUB_REPOSITORY_URL),
        "1.3.6.1.4.1.57264.1.13": der(sha),
        "1.3.6.1.4.1.57264.1.14": der(ref),
        "1.3.6.1.4.1.57264.1.15": der(GITHUB_REPOSITORY_ID),
        "1.3.6.1.4.1.57264.1.18": der(identity),
        "1.3.6.1.4.1.57264.1.19": der(sha),
        "1.3.6.1.4.1.57264.1.20": der("push"),
        "1.3.6.1.4.1.57264.1.21": der(invocation),
        "1.3.6.1.4.1.57264.1.22": der("public"),
        "1.3.6.1.4.1.57264.1.24": der(
          `repo:${GITHUB_REPOSITORY_OWNER}@${GITHUB_REPOSITORY_OWNER_ID}/${GITHUB_REPOSITORY_NAME}@${GITHUB_REPOSITORY_ID}:ref:${ref}`,
        ),
      }),
      ctLogThreshold: 1,
      retry: 0,
      timeout: 10_000,
      tlogThreshold: 1,
    }),
  });
}

function registryKeySelector(value) {
  const root = record(value, "npm registry keys");
  exactKeys(root, ["keys"], "npm registry keys");
  if (!Array.isArray(root.keys) || root.keys.length < 1 || root.keys.length > 8) {
    throw new Error("npm registry key set is not bounded.");
  }
  const keys = new Map();
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
    const id = key.keyid.slice("SHA256:".length);
    const idBytes = Buffer.from(`${id}=`, "base64");
    const keyBytes = Buffer.from(key.key, "base64");
    if (
      idBytes.byteLength !== 32
      || idBytes.toString("base64").slice(0, -1) !== id
      || keyBytes.byteLength === 0
      || keyBytes.toString("base64") !== key.key
    ) throw new Error("npm registry key encoding is not canonical.");
    const encoded = keyBytes.toString("base64").match(/.{1,64}/gu)?.join("\n");
    if (encoded === undefined) throw new Error("npm registry key is invalid.");
    keys.set(key.keyid, `-----BEGIN PUBLIC KEY-----\n${encoded}\n-----END PUBLIC KEY-----\n`);
  }
  return (hint) => keys.get(hint);
}

async function verifyRegistryPublishBundle(
  bundle,
  registryKeys,
  tufCachePath,
) {
  if (typeof tufCachePath !== "string" || tufCachePath.length === 0) {
    throw new Error("npm publish cryptographic verification options are invalid.");
  }
  const { verify } = await import("sigstore");
  await verify(bundle, {
    ctLogThreshold: 0,
    keySelector: registryKeySelector(registryKeys),
    retry: 0,
    timeout: 10_000,
    tlogThreshold: 1,
    tufCachePath,
    tufForceCache: true,
  });
}

async function readInput() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.byteLength;
    if (length > MAXIMUM_INPUT_BYTES) throw new Error("npm cryptographic input exceeded its bound.");
    chunks.push(chunk);
  }
  try {
    return record(JSON.parse(Buffer.concat(chunks, length).toString("utf8")), "npm cryptographic input");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("npm cryptographic input")) throw error;
    throw new Error("npm cryptographic input is not JSON.");
  }
}

async function main() {
  const [mode, ...arguments_] = process.argv.slice(2);
  const input = await readInput();
  const { verify } = await import("sigstore");
  if (mode === "slsa") {
    const [tag, sha, invocation, cachePath] = arguments_;
    if (tag === undefined || sha === undefined || invocation === undefined || cachePath === undefined) {
      throw new Error("SLSA verification arguments are incomplete.");
    }
    exactKeys(input, ["bundle"], "SLSA cryptographic input");
    const bundle = record(input.bundle, "SLSA bundle");
    if (bundle.mediaType !== "application/vnd.dev.sigstore.bundle.v0.3+json") {
      throw new Error("SLSA bundle format is not exact.");
    }
    const policy = releaseSignerIdentity(tag, sha, invocation);
    const signer = await verify(bundle, {
      ...policy.options,
      tufCachePath: cachePath,
      tufForceCache: true,
    });
    if (
      signer.identity?.subjectAlternativeName !== policy.identity
      || signer.identity?.extensions?.issuer !== GITHUB_OIDC_ISSUER
    ) throw new Error("Sigstore verified the wrong npm release signer.");
  } else if (mode === "npm-publish") {
    const [cachePath] = arguments_;
    if (cachePath === undefined) throw new Error("npm publish verification arguments are incomplete.");
    exactKeys(input, ["bundle", "registryKeys"], "npm publish cryptographic input");
    const bundle = record(input.bundle, "npm publish bundle");
    if (bundle.mediaType !== "application/vnd.dev.sigstore.bundle+json;version=0.2") {
      throw new Error("npm publish bundle format is not exact.");
    }
    await verifyRegistryPublishBundle(bundle, input.registryKeys, cachePath);
  } else {
    throw new Error("npm cryptographic verification mode is invalid.");
  }
  process.stdout.write("verified\n");
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    await main();
  } catch {
    process.stderr.write("npm cryptographic verification failed.\n");
    process.exitCode = 1;
  }
}
