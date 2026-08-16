import {
  RUN_INTERACTION_RESPONSE_PADDED_BYTES,
  RUN_INTERACTION_RESPONSE_LENGTH_BYTES,
  runInteractionRequestPayloadSchema,
  runInteractionRequestSchema,
  sealedRunInteractionResponseSchema,
  validateRunInteractionResponse,
  type RunInteractionRequest,
  type RunInteractionRequestPayload,
  type RunInteractionResponse,
  type SealedRunInteractionResponse,
} from "./interactions";
import { dispatchIdSchema } from "./dispatch-identifiers";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
// This value is part of the v1 ciphertext key schedule. Its historical bytes
// remain stable so HRA can decrypt interaction responses created pre-rename.
const STABLE_HITL_RESPONSE_HKDF_INFO = textEncoder.encode(
  "kitchen.hitl.response.v1",
);

export interface RunInteractionReplyKeyPair {
  readonly keyId: string;
  readonly privateKey: CryptoKey;
  readonly publicKey: string;
}

export interface RunInteractionSealContext {
  readonly runId: string;
  readonly workspaceId: string;
}

export async function createRunInteractionReplyKeyPair(): Promise<RunInteractionReplyKeyPair> {
  const subtle = requireWebCrypto().subtle;
  const generated = await subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  if (!("privateKey" in generated) || !("publicKey" in generated)) {
    throw new Error("The platform did not create an ECDH key pair");
  }
  const publicBytes = new Uint8Array(await subtle.exportKey("raw", generated.publicKey));
  const keyIdBytes = new Uint8Array(16);
  requireWebCrypto().getRandomValues(keyIdBytes);
  return {
    keyId: `hitlkey_${hex(keyIdBytes)}`,
    privateKey: generated.privateKey,
    publicKey: base64UrlEncode(publicBytes),
  };
}

export function interactionRequestPayload(
  request: RunInteractionRequest,
): RunInteractionRequestPayload {
  const parsed = runInteractionRequestSchema.parse(request);
  return runInteractionRequestPayloadSchema.parse(parsed.kind === "user_input"
    ? {
        id: parsed.id,
        kind: parsed.kind,
        createdAt: parsed.createdAt,
        expiresAt: parsed.expiresAt,
        questions: parsed.questions,
      }
    : {
        id: parsed.id,
        kind: parsed.kind,
        createdAt: parsed.createdAt,
        expiresAt: parsed.expiresAt,
        scope: parsed.scope,
      });
}

export async function createRunInteractionRequestDigest(
  payload: RunInteractionRequestPayload,
): Promise<string> {
  const canonical = JSON.stringify(runInteractionRequestPayloadSchema.parse(payload));
  const digest = new Uint8Array(await requireWebCrypto().subtle.digest(
    "SHA-256",
    textEncoder.encode(canonical),
  ));
  return `sha256_${hex(digest)}`;
}

export async function sealRunInteractionResponse(
  requestValue: RunInteractionRequest,
  contextValue: RunInteractionSealContext,
  responseValue: RunInteractionResponse,
): Promise<SealedRunInteractionResponse> {
  const request = runInteractionRequestSchema.parse(requestValue);
  await assertRequestDigest(request);
  const context = parseSealContext(contextValue);
  const checked = validateRunInteractionResponse(request, responseValue);
  if (!checked.success) throw new Error(`Invalid interaction response: ${checked.reason}`);
  const crypto = requireWebCrypto();
  const ephemeral = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  if (!("privateKey" in ephemeral) || !("publicKey" in ephemeral)) {
    throw new Error("The platform did not create an ephemeral ECDH key pair");
  }
  const recipient = await crypto.subtle.importKey(
    "raw",
    ownedBuffer(base64UrlDecode(request.reply.publicKey)),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const aad = interactionResponseAad(request, context);
  const key = await deriveResponseKey(ephemeral.privateKey, recipient, aad, ["encrypt"]);
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const plaintext = paddedResponsePayload(checked.data);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: ownedBuffer(nonce),
      additionalData: ownedBuffer(aad),
      tagLength: 128,
    },
    key,
    ownedBuffer(plaintext),
  ));
  const ephemeralPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  return sealedRunInteractionResponseSchema.parse({
    version: 1,
    algorithm: "P256-HKDF-SHA256-A256GCM",
    keyId: request.reply.keyId,
    workspaceId: context.workspaceId,
    ephemeralPublicKey: base64UrlEncode(ephemeralPublicKey),
    nonce: base64UrlEncode(nonce),
    ciphertext: base64UrlEncode(ciphertext),
  });
}

export async function openRunInteractionResponse(
  requestValue: RunInteractionRequest,
  contextValue: RunInteractionSealContext,
  sealedValue: SealedRunInteractionResponse,
  privateKey: CryptoKey,
): Promise<RunInteractionResponse> {
  const request = runInteractionRequestSchema.parse(requestValue);
  await assertRequestDigest(request);
  const context = parseSealContext(contextValue);
  const sealed = sealedRunInteractionResponseSchema.parse(sealedValue);
  if (sealed.keyId !== request.reply.keyId || sealed.workspaceId !== context.workspaceId) {
    throw new Error("Sealed interaction response has the wrong authority context");
  }
  const crypto = requireWebCrypto();
  const ephemeral = await crypto.subtle.importKey(
    "raw",
    ownedBuffer(base64UrlDecode(sealed.ephemeralPublicKey)),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const aad = interactionResponseAad(request, context);
  const key = await deriveResponseKey(privateKey, ephemeral, aad, ["decrypt"]);
  let plaintext: Uint8Array;
  try {
    plaintext = new Uint8Array(await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: ownedBuffer(base64UrlDecode(sealed.nonce)),
        additionalData: ownedBuffer(aad),
        tagLength: 128,
      },
      key,
      ownedBuffer(base64UrlDecode(sealed.ciphertext)),
    ));
  } catch {
    throw new Error("Sealed interaction response authentication failed");
  }
  if (plaintext.byteLength !== RUN_INTERACTION_RESPONSE_PADDED_BYTES) {
    throw new Error("Sealed interaction response has an invalid padded length");
  }
  const view = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
  const length = view.getUint32(0, false);
  if (length === 0 || length > plaintext.byteLength - RUN_INTERACTION_RESPONSE_LENGTH_BYTES) {
    throw new Error("Sealed interaction response has an invalid content length");
  }
  let value: unknown;
  try {
    value = JSON.parse(textDecoder.decode(
      plaintext.subarray(
        RUN_INTERACTION_RESPONSE_LENGTH_BYTES,
        RUN_INTERACTION_RESPONSE_LENGTH_BYTES + length,
      ),
    )) as unknown;
  } catch {
    throw new Error("Sealed interaction response is not valid JSON");
  }
  const checked = validateRunInteractionResponse(request, value);
  if (!checked.success) throw new Error(`Sealed interaction response is invalid: ${checked.reason}`);
  return checked.data;
}

export function interactionResponseAad(
  requestValue: RunInteractionRequest,
  contextValue: RunInteractionSealContext,
): Uint8Array {
  const request = runInteractionRequestSchema.parse(requestValue);
  const context = parseSealContext(contextValue);
  return textEncoder.encode(JSON.stringify({
    version: 1,
    workspaceId: context.workspaceId,
    runId: context.runId,
    interactionId: request.id,
    runnerId: request.reply.runnerId,
    bootId: request.reply.bootId,
    bootGeneration: request.reply.bootGeneration,
    claimId: request.reply.claimId,
    claimFence: request.reply.claimFence,
    requestDigest: request.reply.requestDigest,
    expiresAt: request.expiresAt,
    keyId: request.reply.keyId,
  }));
}

function parseSealContext(context: RunInteractionSealContext): RunInteractionSealContext {
  if (!dispatchIdSchema.safeParse(context.runId).success) throw new Error("Invalid interaction run ID");
  if (context.workspaceId.length < 1 || context.workspaceId.length > 128) {
    throw new Error("Invalid interaction workspace ID");
  }
  return context;
}

async function assertRequestDigest(request: RunInteractionRequest): Promise<void> {
  const digest = await createRunInteractionRequestDigest(interactionRequestPayload(request));
  if (digest !== request.reply.requestDigest) {
    throw new Error("Interaction request digest does not match its public payload");
  }
}

async function deriveResponseKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  aad: Uint8Array,
  usages: readonly ("encrypt" | "decrypt")[],
): Promise<CryptoKey> {
  const subtle = requireWebCrypto().subtle;
  const shared = await subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const keyMaterial = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const salt = await subtle.digest("SHA-256", ownedBuffer(aad));
  return await subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: STABLE_HITL_RESPONSE_HKDF_INFO,
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

function paddedResponsePayload(response: RunInteractionResponse): Uint8Array {
  const encoded = textEncoder.encode(JSON.stringify(response));
  if (
    encoded.byteLength >
      RUN_INTERACTION_RESPONSE_PADDED_BYTES - RUN_INTERACTION_RESPONSE_LENGTH_BYTES
  ) {
    throw new Error("Interaction response exceeds the sealed response envelope");
  }
  const payload = new Uint8Array(RUN_INTERACTION_RESPONSE_PADDED_BYTES);
  requireWebCrypto().getRandomValues(payload);
  new DataView(payload.buffer).setUint32(0, encoded.byteLength, false);
  payload.set(encoded, RUN_INTERACTION_RESPONSE_LENGTH_BYTES);
  return payload;
}

function requireWebCrypto(): Crypto {
  const crypto = globalThis.crypto;
  if (crypto === undefined) throw new Error("Web Crypto is unavailable");
  return crypto;
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}
