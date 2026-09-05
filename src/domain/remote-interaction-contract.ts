/**
 * Browser-safe wire vocabulary for remote interaction policy.
 *
 * This module deliberately has no imports. The web app consumes compact
 * projection types from the source tree, so pulling provider or daemon modules
 * through this boundary would make Node-only dependencies part of its bundle.
 */

export const remoteInteractionPolicyLimits = Object.freeze({
  actions: 2,
  displayMetadataCharacters: 2_048,
  optionDescriptionCharacters: 512,
  optionLabelCharacters: 256,
  options: 20,
  questionIdCharacters: 128,
  questionLabelCharacters: 256,
  questionTextCharacters: 2_048,
  questions: 8,
} as const);

export const remoteInteractionAnswerLimits = Object.freeze({
  codePoints: 16_384,
  codeUnits: 16_384,
  providerJsonBytes: 64 * 1024,
} as const);

const credentialPromptPattern =
  /\b(?:api[ _.:-]?key|access[ _.:-]?token|bearer|credential|password|passphrase|passcode|private[ _.:-]?key|secret|verification[ _.:-]?code|one[ _.:-]?time[ _.:-]?(?:code|password)|otp|pin)\b/iu;
const credentialFieldNamePattern =
  /(?:token|secret|password|passphrase|passcode|credential|api[_.-]?key|private[_.-]?key|auth|cookie|session|verification[_.-]?code|one[_.-]?time[_.-]?(?:code|password)|(?:github|gitlab)[_.-]?pat|(?:^|[_.-])(?:otp|pat|pin)(?:$|[_.-]))/iu;

export function containsCredentialPrompt(value: string): boolean {
  return credentialPromptPattern.test(value) || credentialFieldNamePattern.test(value);
}

const remoteInteractionTextEncoder = new TextEncoder();

/** The provider's canonical JSON order does not change its encoded byte size. */
export function remoteInteractionJsonFitsProviderLimit(value: unknown): boolean {
  try {
    const serialized: unknown = JSON.stringify(value);
    return typeof serialized === "string"
      && remoteInteractionTextEncoder.encode(serialized).byteLength
        <= remoteInteractionAnswerLimits.providerJsonBytes;
  } catch {
    return false;
  }
}

/** Global wire order. A producer may return a subsequence, never reorder it. */
export const remoteInteractionActionOrder = Object.freeze([
  "decline",
  "answer",
] as const);

export type RemoteInteractionAction = typeof remoteInteractionActionOrder[number];

/** Closed wire order for strict policy parsers and exhaustive copy maps. */
export const remoteInteractionPolicyReasonCodeOrder = Object.freeze([
  "INTERACTION_NOT_PENDING",
  "INTERACTION_EXPIRED",
  "INTERACTION_TIME_INVALID",
  "COMMAND_APPROVAL_LOCAL_ONLY",
  "COMMAND_DECLINE_NOT_OFFERED",
  "FILE_CHANGE_APPROVAL_LOCAL_ONLY",
  "FILE_CHANGE_DECLINE_NOT_OFFERED",
  "PERMISSION_APPROVAL_LOCAL_ONLY",
  "PERMISSION_REQUEST_EMPTY",
  "USER_INPUT_SECRET_QUESTION",
  "USER_INPUT_FREE_TEXT_LOCAL_ONLY",
  "USER_INPUT_PROVIDER_CONTRACT_LOCAL_ONLY",
  "USER_INPUT_METADATA_UNPROJECTABLE",
  "MCP_MODE_UNSUPPORTED",
  "MCP_FIELDS_MISSING",
  "MCP_ANSWER_LOCAL_ONLY",
] as const);

export type RemoteInteractionPolicyReasonCode =
  typeof remoteInteractionPolicyReasonCodeOrder[number];

export type RemoteUserInputQuestion = Readonly<{
  allowsOther: false;
  header: string;
  id: string;
  kind: "user_input";
  options: readonly Readonly<{ description: string; label: string }>[];
  question: string;
}>;

/** Exact metadata a browser needs in order to construct one admitted answer. */
export type RemoteInteractionProjectedQuestion = RemoteUserInputQuestion;
