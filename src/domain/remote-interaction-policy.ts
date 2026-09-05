import {
  type InteractionDisplay,
  type InteractionState,
} from "./interactions";
import {
  containsCredentialPrompt,
  remoteInteractionActionOrder,
  remoteInteractionPolicyLimits,
  remoteInteractionPolicyReasonCodeOrder,
  type RemoteInteractionAction,
  type RemoteInteractionPolicyReasonCode,
  type RemoteInteractionProjectedQuestion,
  type RemoteUserInputQuestion,
} from "./remote-interaction-contract";
import {
  containsAbsolutePath,
  containsSecretShapedText,
  containsUnsafeTerminalScalar,
} from "./text-safety";

export {
  remoteInteractionAnswerLimits,
  remoteInteractionActionOrder,
  remoteInteractionJsonFitsProviderLimit,
  remoteInteractionPolicyLimits,
  remoteInteractionPolicyReasonCodeOrder,
} from "./remote-interaction-contract";
export type {
  RemoteInteractionAction,
  RemoteInteractionPolicyReasonCode,
  RemoteInteractionProjectedQuestion,
  RemoteUserInputQuestion,
} from "./remote-interaction-contract";

export type RemoteInteractionReachability = Readonly<{
  actions: readonly RemoteInteractionAction[];
  answerActions: number;
  decisionActions: number;
  state: "machine_only" | "remote_actionable";
}>;

export type RemoteInteractionPolicy = Readonly<{
  /** The complete action authority, in `remoteInteractionActionOrder`. */
  actions: readonly RemoteInteractionAction[];
  /** Exact local deadline used by the final pending-state policy gate. */
  deadlineAt: number;
  /** Reasons actions were omitted, plus reviewed partial-form limitations. */
  reasonCodes: readonly RemoteInteractionPolicyReasonCode[];
  /** Exact metadata required by the `answer` action, otherwise empty. */
  questions: readonly RemoteInteractionProjectedQuestion[];
  /** A presentation summary derived from `actions`, never separate authority. */
  reachability: RemoteInteractionReachability;
}>;

const projectionMutationMarkerPattern =
  /(?:\[(?:protected|local-path|cloud projection[^\]]*)\]|�)/iu;

function projectionTextIsExact(
  value: string,
  maximum: number,
  options: Readonly<{ allowEmpty?: boolean; credentialPrompt?: boolean }> = {},
): boolean {
  return (options.allowEmpty === true || value.length > 0)
    && value.length <= maximum
    && !containsAbsolutePath(value)
    && !containsUnsafeTerminalScalar(value)
    && !containsSecretShapedText(value)
    && !projectionMutationMarkerPattern.test(value)
    && (options.credentialPrompt !== true
      || !containsCredentialPrompt(value));
}

function exactQuestionMetadataSize(
  questions: readonly RemoteUserInputQuestion[],
): number {
  return questions.reduce((total, question) => total
    + question.id.length
    + question.header.length
    + question.question.length
    + question.options.reduce((optionTotal, option) =>
      optionTotal + option.label.length + option.description.length, 0), 0);
}

function remoteUserInputQuestions(
  display: Extract<InteractionDisplay, { readonly kind: "user_input" }>,
): readonly RemoteUserInputQuestion[] | null {
  if (
    display.questions.length < 1
    || display.questions.length > remoteInteractionPolicyLimits.questions
  ) return null;
  const projected: RemoteUserInputQuestion[] = [];
  for (const question of display.questions) {
    const options = question.options;
    if (
      question.secret
      || question.allowsOther
      || options === null
      || !projectionTextIsExact(
        question.id,
        remoteInteractionPolicyLimits.questionIdCharacters,
        { credentialPrompt: true },
      )
      || !projectionTextIsExact(
        question.header,
        remoteInteractionPolicyLimits.questionLabelCharacters,
        { credentialPrompt: true },
      )
      || !projectionTextIsExact(
        question.question,
        remoteInteractionPolicyLimits.questionTextCharacters,
        { credentialPrompt: true },
      )
      || options.length === 0
      || options.length > remoteInteractionPolicyLimits.options
      || new Set(options.map((option) => option.label)).size !== options.length
      || options.some((option) =>
            !projectionTextIsExact(
              option.label,
              remoteInteractionPolicyLimits.optionLabelCharacters,
              { credentialPrompt: true },
            )
            || !projectionTextIsExact(
              option.description,
              remoteInteractionPolicyLimits.optionDescriptionCharacters,
              { allowEmpty: true, credentialPrompt: true },
            ))
    ) return null;
    projected.push({
      allowsOther: false,
      header: question.header,
      id: question.id,
      kind: "user_input",
      options: options.map((option) => ({ ...option })),
      question: question.question,
    });
  }
  if (
    new Set(projected.map((question) => question.id)).size !== projected.length
    || new Set(projected.map((question) => question.question)).size !== projected.length
  ) return null;
  return exactQuestionMetadataSize(projected)
    <= remoteInteractionPolicyLimits.displayMetadataCharacters
    ? projected
    : null;
}

/** Derives presentation reachability from the action set itself. */
export function summarizeRemoteInteractionReachability(
  actions: readonly RemoteInteractionAction[],
): RemoteInteractionReachability {
  const canonical = remoteInteractionActionOrder.filter((action) => actions.includes(action));
  return {
    actions: canonical,
    answerActions: canonical.includes("answer") ? 1 : 0,
    decisionActions: canonical.filter((action) => action !== "answer").length,
    state: canonical.length === 0 ? "machine_only" : "remote_actionable",
  };
}

function policy(input: Readonly<{
  actions: readonly RemoteInteractionAction[];
  questions?: readonly RemoteInteractionProjectedQuestion[];
  reasonCodes?: readonly RemoteInteractionPolicyReasonCode[];
}>): Omit<RemoteInteractionPolicy, "deadlineAt"> {
  const actions = remoteInteractionActionOrder.filter((action) => input.actions.includes(action));
  const reasonCodes = remoteInteractionPolicyReasonCodeOrder.filter((reason) =>
    input.reasonCodes?.includes(reason));
  return {
    actions,
    questions: input.questions ?? [],
    reachability: summarizeRemoteInteractionReachability(actions),
    reasonCodes,
  };
}

/**
 * Computes the exact remote action set from one already-sanitised live
 * display. This function is pure and is suitable for projection, rendering,
 * notification metadata, and authoritative recomputation immediately before
 * the local custodian applies an action.
 */
function computeRemoteInteractionDisplayPolicy(
  display: InteractionDisplay,
): Omit<RemoteInteractionPolicy, "deadlineAt"> {
  switch (display.kind) {
    case "command_approval": {
      const reasons: RemoteInteractionPolicyReasonCode[] = [
        "COMMAND_APPROVAL_LOCAL_ONLY",
      ];
      const actions: RemoteInteractionAction[] = [];
      if (!display.availableDecisions.includes("decline")) {
        reasons.push("COMMAND_DECLINE_NOT_OFFERED");
      } else {
        actions.push("decline");
      }
      return policy({
        actions,
        reasonCodes: reasons,
      });
    }
    case "file_change_approval": {
      const offered = display.availableDecisions.includes("decline");
      return policy({
        actions: offered ? ["decline"] : [],
        reasonCodes: [
          "FILE_CHANGE_APPROVAL_LOCAL_ONLY",
          ...(offered ? [] : ["FILE_CHANGE_DECLINE_NOT_OFFERED"] as const),
        ],
      });
    }
    case "permission_approval": {
      const reasons: RemoteInteractionPolicyReasonCode[] = [
        "PERMISSION_APPROVAL_LOCAL_ONLY",
      ];
      if (display.requested.length === 0) reasons.push("PERMISSION_REQUEST_EMPTY");
      return policy({
        // The public display contains only provider category names. Their
        // protected values can still name paths or scopes outside the
        // workspace, so no remote reader has enough evidence to grant them.
        actions: ["decline"],
        reasonCodes: reasons,
      });
    }
    case "user_input": {
      const reasons: RemoteInteractionPolicyReasonCode[] = [];
      if (display.questions.some((question) => question.secret)) {
        reasons.push("USER_INPUT_SECRET_QUESTION");
      }
      if (display.questions.some((question) =>
        question.options === null || question.allowsOther)) {
        reasons.push("USER_INPUT_FREE_TEXT_LOCAL_ONLY");
      }
      if (display.questions.some((question) =>
        !Object.hasOwn(question, "remoteAnswerable") || question.remoteAnswerable !== true)) {
        reasons.push("USER_INPUT_PROVIDER_CONTRACT_LOCAL_ONLY");
      }
      const questions = reasons.length === 0 ? remoteUserInputQuestions(display) : null;
      if (reasons.length === 0 && questions === null) {
        reasons.push("USER_INPUT_METADATA_UNPROJECTABLE");
      }
      return policy({
        actions: reasons.length === 0 ? ["answer"] : [],
        questions: reasons.length === 0 && questions !== null ? questions : [],
        reasonCodes: reasons,
      });
    }
    case "mcp_elicitation": {
      // The provider-neutral display no longer carries the original field
      // title, description, or request message. A field named `region` can
      // therefore still be asking for a credential. No name heuristic can
      // establish non-secret authority, so every MCP answer remains local.
      const reasons: RemoteInteractionPolicyReasonCode[] = ["MCP_ANSWER_LOCAL_ONLY"];
      if (display.mode !== "form") reasons.push("MCP_MODE_UNSUPPORTED");
      if (display.fields === undefined || display.fields.length === 0) {
        reasons.push("MCP_FIELDS_MISSING");
      }
      return policy({
        actions: [],
        questions: [],
        reasonCodes: reasons,
      });
    }
    default: {
      const exhaustive: never = display;
      throw new Error(`Unhandled interaction display kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Authoritative policy gate for one exact live interaction revision.
 *
 * `now` is injected so callers and tests agree at the exact deadline boundary.
 * Session scope and cancel are deliberately absent from the action vocabulary;
 * they always remain with the local custodian. Only pending, unexpired,
 * non-secret closed-choice user questions with an exact provider translation
 * can be answered remotely. Free text, MCP forms, and unknown modes stay local.
 */
export function deriveRemoteInteractionPolicy(
  input: Readonly<{
    deadlineAt: number;
    display: InteractionDisplay;
    state: InteractionState;
  }>,
  now: number,
): RemoteInteractionPolicy {
  if (
    !Number.isSafeInteger(input.deadlineAt)
    || input.deadlineAt < 0
    || !Number.isSafeInteger(now)
    || now < 0
  ) {
    return {
      ...policy({ actions: [], reasonCodes: ["INTERACTION_TIME_INVALID"] }),
      deadlineAt: input.deadlineAt,
    };
  }
  if (input.state !== "pending") {
    return {
      ...policy({ actions: [], reasonCodes: ["INTERACTION_NOT_PENDING"] }),
      deadlineAt: input.deadlineAt,
    };
  }
  if (now >= input.deadlineAt) {
    return {
      ...policy({ actions: [], reasonCodes: ["INTERACTION_EXPIRED"] }),
      deadlineAt: input.deadlineAt,
    };
  }
  return {
    ...computeRemoteInteractionDisplayPolicy(input.display),
    deadlineAt: input.deadlineAt,
  };
}
