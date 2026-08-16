import {
  runInteractionRequestPayloadSchema,
  validateRunInteractionResponse,
  type RunInteractionRequestPayload,
  type RunInteractionResponse,
} from "@hraness/agent-tasks-protocol";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import type { CodexServerRequest } from "../codex";

export interface ParsedSessionInteraction {
  readonly activityKind: "waiting_for_approval" | "waiting_for_input";
  readonly publicRequest: RunInteractionRequestPayload;
  readonly threadId: string;
  readonly turnId: string;
  readonly providerResponse: (response: RunInteractionResponse) => unknown;
}

export interface SessionInteractionParseContext {
  readonly interactionId: string;
  readonly createdAt: number;
  readonly defaultExpiresAt: number;
  readonly laneMode: "managed" | "local" | "readOnly";
  readonly worktreePath: string;
}

/**
 * Translates the two deliberately supported callbacks into a HRA-owned
 * request. Provider IDs survive only inside the returned response closure.
 * The provider's `isSecret: false` classification is structural authority,
 * not semantic DLP over the browser-visible question text.
 */
export function projectSessionInteraction(
  request: CodexServerRequest,
  context: SessionInteractionParseContext,
): ParsedSessionInteraction | null {
  if (request.method === "item/tool/requestUserInput") {
    const params = request.params;
    if (params.questions.some(({ isSecret }) => isSecret)) return null;
    const expiresAt = Math.min(
      context.defaultExpiresAt,
      context.createdAt + (params.autoResolutionMs ?? 3_600_000),
    );
    const questionMappings = params.questions.map((question, questionIndex) => {
      const publicQuestionId = stableWireId("question", context.interactionId, questionIndex);
      const options = (question.options ?? []).map((option, optionIndex) => ({
        publicId: stableWireId("option", publicQuestionId, optionIndex),
        providerLabel: option.label,
        description: option.description,
      }));
      return {
        publicId: publicQuestionId,
        providerId: question.id,
        allowOther: question.isOther || options.length === 0,
        options,
        header: question.header,
        prompt: question.question,
      };
    });
    const publicRequest = runInteractionRequestPayloadSchema.parse({
      id: context.interactionId,
      kind: "user_input",
      createdAt: context.createdAt,
      expiresAt,
      questions: questionMappings.map((question) => ({
        id: question.publicId,
        header: question.header,
        prompt: question.prompt,
        allowOther: question.allowOther,
        options: question.options.map((option) => ({
          id: option.publicId,
          label: option.providerLabel,
          ...(option.description.length === 0 ? {} : { description: option.description }),
        })),
      })),
    });
    return {
      activityKind: "waiting_for_input",
      publicRequest,
      threadId: params.threadId,
      turnId: params.turnId,
      providerResponse: (response) => {
        const checked = validateRunInteractionResponse(publicRequest, response);
        if (!checked.success || checked.data.kind !== "user_input") {
          throw new Error("Interaction response does not match its request");
        }
        const answerEntries: Array<readonly [
          string,
          { readonly answers: readonly string[] },
        ]> = [];
        for (const answer of checked.data.answers) {
          const question = questionMappings.find(({ publicId }) => publicId === answer.questionId);
          if (question === undefined) throw new Error("Interaction question mapping expired");
          const selected = answer.selectedOptionIds.map((optionId) => {
            const option = question.options.find(({ publicId }) => publicId === optionId);
            if (option === undefined) throw new Error("Interaction option mapping expired");
            return option.providerLabel;
          });
          answerEntries.push([question.providerId, {
            answers: answer.otherText === undefined ? selected : [...selected, answer.otherText],
          }]);
        }
        return { answers: Object.fromEntries(answerEntries) };
      },
    };
  }

  if (request.method === "item/fileChange/requestApproval") {
    const params = request.params;
    if (context.laneMode !== "managed" || typeof params.grantRoot !== "string") return null;
    if (!isContainedGrantRoot(context.worktreePath, params.grantRoot)) return null;
    const publicRequest = runInteractionRequestPayloadSchema.parse({
      id: context.interactionId,
      kind: "file_change_approval",
      scope: "once",
      createdAt: context.createdAt,
      expiresAt: context.defaultExpiresAt,
    });
    return {
      activityKind: "waiting_for_approval",
      publicRequest,
      threadId: params.threadId,
      turnId: params.turnId,
      providerResponse: (response) => {
        const checked = validateRunInteractionResponse(publicRequest, response);
        if (!checked.success || checked.data.kind !== "file_change_approval") {
          throw new Error("Interaction response does not match its request");
        }
        switch (checked.data.decision) {
          case "approve_once":
            return { decision: "accept" };
          case "decline":
            return { decision: "decline" };
          case "cancel":
            return { decision: "cancel" };
        }
      },
    };
  }
  return null;
}

function isContainedGrantRoot(worktreePath: string, grantRoot: string): boolean {
  if (!isAbsolute(worktreePath) || !isAbsolute(grantRoot)) return false;
  try {
    const contained = relative(
      realpathSync(resolve(worktreePath)),
      realpathSync(resolve(grantRoot)),
    );
    return contained === "" || (!contained.startsWith("..") && !isAbsolute(contained));
  } catch {
    return false;
  }
}

function stableWireId(prefix: "option" | "question", material: string, index: number): string {
  const digest = createHash("sha256")
    .update(`oprte-interaction-${prefix}-v1:${material}:${String(index)}`)
    .digest("hex");
  return `${prefix}_${digest.slice(0, 48)}`;
}
