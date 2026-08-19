import { z } from "@hra-internal/schema";

import {
  chatRootTurnRoutingProjectionSchema,
  runtimeChatTurnPromptUtf8ByteLimit,
  type ChatRootTurnRoutingClassificationReason,
  type ChatRootTurnRoutingProjection,
  type ChatRootTurnWorkClass,
} from "../../../contracts/runtime";

export const ROOT_TURN_ROUTING_POLICY_VERSION = 1 as const;

const utf8Encoder = new TextEncoder();
const classifierInputSchema = z.object({
  prompt: z.string(),
  requiredInputClass: z.enum(["text", "image"]).default("text"),
  priorRouting: chatRootTurnRoutingProjectionSchema.nullable().optional(),
}).strict().superRefine((input, context) => {
  const byteLength = utf8Encoder.encode(input.prompt).byteLength;
  if (
    byteLength > runtimeChatTurnPromptUtf8ByteLimit ||
    input.prompt.includes("\0") ||
    (input.requiredInputClass === "text" && input.prompt.trim().length === 0)
  ) {
    context.addIssue({
      code: "custom",
      message: "root-turn input must be bounded, admissible, and NUL-free",
      path: ["prompt"],
    });
  }
});

const exactContinuationPattern = /^(?:please\s+)?(?:continue(?:\s+(?:it|that|this))?|keep going|go ahead|proceed|do it|ship it|finish(?:\s+(?:it|that|this))?|apply(?:\s+(?:it|that|this))?|fix(?:\s+(?:it|that|this))?|same|yes|yep|ok(?:ay)?)[.!?…]*$/u;
const continuationLeadPattern = /^(?:please\s+)?(?:continue\b|keep going\b|go ahead\b|proceed\b|carry on\b|pick up\b)/u;
const deicticPattern = /\b(?:it|that|this|those|these|same|above|previous|prior)\b/u;
const wideResearchActionPattern = /\b(?:research|investigate|survey|compare|benchmark|evaluate|analy[sz]e|audit|review|map)\b/u;
const wideResearchBreadthPattern = /\b(?:across|app|architecture|codebase|ecosystem|frontend and backend|landscape|literature|prior art|repository|sources|system)\b|\b(?:all|every) (?:the )?(?:code|files?|packages)\b|\bmultiple packages\b/u;
const explicitWideResearchPattern = /\b(?:broad|comprehensive|deep|wide)[ -](?:audit|research|review|survey|investigation|analysis)\b/u;
const largeChangeActionPattern = /\b(?:add|build|change|create|develop|enable|implement|integrate|migrate|overhaul|redesign|refactor|replace|rewrite|ship|update)\b/u;
const strongBreadthPattern = /\b(?:across|cross-cutting|end-to-end|frontend and backend|throughout)\b|\b(?:all|every) (?:the )?(?:code|files?|packages)\b|\b(?:entire|whole) (?:app|architecture|codebase|frontend and backend|repository|system)\b|\b(?:multiple|several) (?:components|files?|modules|packages|subsystems)\b/u;
const explicitLargeChangePattern = /\b(?:full implementation|large change|major (?:change|feature|refactor|rewrite)|new feature|system-wide)\b/u;
const featureImplementationPattern = /\b(?:add|build|create|develop|enable|implement|integrate|ship)\b[^.!?\n]{0,64}\bfeature\b/u;
const structuralChangePattern = /\b(?:migrate|overhaul|redesign|refactor|rewrite)\b[^.!?\n]{0,64}\b(?:architecture|codebase|repository|system)\b/u;
const narrowActionPattern = /\b(?:add|adjust|change|correct|delete|fix|remove|rename|tweak|update)\b/u;
const narrowTargetPattern = /\b(?:aria-label|assertion|button|color|copy|icon|label|margin|one file|padding|readme|single file|spacing|string|test|text|this component|this file|this function|this test|tooltip|typo)\b/u;
const narrowQualifierPattern = /\b(?:just|narrow|one|only|single|small|tiny)\b/u;
const leafBlockerPattern = /\b(?:architecture|authentication|concurrency|cross-cutting|database|end-to-end|implement|investigate|lifecycle|migrate|migration|multiple|persistence|protocol|provider|recovery|redesign|refactor|research|rewrite|routing|schema|security|system|throughout)\b/u;
const filePathPattern = /(?:^|[\s`'"(])(?:\.?\.?\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+(?:\.[A-Za-z0-9_-]+)?(?=$|[\s`'"),:;])/gu;

function countMatches(value: string, pattern: RegExp, limit: number): number {
  let count = 0;
  pattern.lastIndex = 0;
  while (pattern.exec(value) !== null && count < limit) count += 1;
  pattern.lastIndex = 0;
  return count;
}

function classifyPrompt(prompt: string): Readonly<{
  classificationReason: ChatRootTurnRoutingClassificationReason;
  workClass: ChatRootTurnWorkClass;
}> {
  const normalized = prompt.trim().normalize("NFKC").toLowerCase()
    .replace(/\bcross[\s\u2010-\u2015-]+cutting\b/gu, "cross-cutting")
    .replace(
      /\bend[\s\u2010-\u2015-]+to[\s\u2010-\u2015-]+end\b/gu,
      "end-to-end",
    );
  const words = normalized.match(/[\p{L}\p{N}_-]+/gu)?.length ?? 0;
  const promptBytes = utf8Encoder.encode(prompt).byteLength;
  const lineCount = prompt.split(/\r?\n/u).length;
  const exactContinuation = words <= 8 && exactContinuationPattern.test(normalized);
  const continuationLead = words <= 24 && continuationLeadPattern.test(normalized);
  if (exactContinuation) {
    return {
      classificationReason: "continuationOrAmbiguous",
      workClass: "standard",
    };
  }

  const filePathCount = countMatches(normalized, filePathPattern, 3);
  const namedNarrowTarget = narrowTargetPattern.test(normalized) ||
    filePathCount === 1;
  const strongBreadth = strongBreadthPattern.test(normalized) ||
    filePathCount >= 3;
  const hasWideResearchCue = explicitWideResearchPattern.test(normalized) ||
    (
      wideResearchActionPattern.test(normalized) &&
      wideResearchBreadthPattern.test(normalized) &&
      (!namedNarrowTarget || strongBreadth)
    );
  if (hasWideResearchCue) {
    return {
      classificationReason: "wideResearchCue",
      workClass: "wideResearch",
    };
  }

  const hasLargeChangeCue = explicitLargeChangePattern.test(normalized) ||
    (featureImplementationPattern.test(normalized) && !namedNarrowTarget) ||
    (structuralChangePattern.test(normalized) && !namedNarrowTarget) ||
    (
      largeChangeActionPattern.test(normalized) &&
      strongBreadth
    );
  if (hasLargeChangeCue) {
    return {
      classificationReason: "largeChangeCue",
      workClass: "largeChange",
    };
  }

  const shortDeictic = words <= 12 && deicticPattern.test(normalized) &&
    !narrowTargetPattern.test(normalized) &&
    !leafBlockerPattern.test(normalized);
  if (shortDeictic) {
    return {
      classificationReason: "continuationOrAmbiguous",
      workClass: "standard",
    };
  }

  const hasNarrowCue = narrowActionPattern.test(normalized) &&
    (
      narrowTargetPattern.test(normalized) ||
      narrowQualifierPattern.test(normalized) ||
      filePathCount === 1
    );
  const boundedShape = promptBytes <= 1_200 && lineCount <= 24 && words <= 180;
  const ambiguousShape = normalized.includes("```") ||
    leafBlockerPattern.test(normalized) ||
    filePathCount >= 2;
  if (hasNarrowCue && boundedShape && !ambiguousShape) {
    return {
      classificationReason: "boundedLeafCue",
      workClass: "boundedLeaf",
    };
  }

  if (continuationLead) {
    return {
      classificationReason: "continuationOrAmbiguous",
      workClass: "standard",
    };
  }

  return {
    classificationReason: "conservativeDefault",
    workClass: "standard",
  };
}

function requestedProfile(
  workClass: ChatRootTurnWorkClass,
): ChatRootTurnRoutingProjection["requestedProfile"] {
  switch (workClass) {
    case "boundedLeaf":
      return "lunaMax";
    case "standard":
      return "solMax";
    case "largeChange":
    case "wideResearch":
      return "solUltra";
  }
}

function requestedServiceTier(
  classificationReason: ChatRootTurnRoutingClassificationReason,
): ChatRootTurnRoutingProjection["requestedServiceTier"] {
  return classificationReason === "boundedLeafCue" ||
      classificationReason === "continuationOrAmbiguous"
    ? "fast"
    : "standard";
}

/**
 * Classify one root prompt without provider work or retained prompt material.
 * Capability resolution is a separate durable transition, so every initial
 * classification leaves its selected profile unresolved.
 */
export function classifyRootTurnRoutingV1(
  inputValue: unknown,
): ChatRootTurnRoutingProjection {
  const input = classifierInputSchema.parse(inputValue);
  const classification = input.requiredInputClass === "image"
    ? {
        classificationReason: "conservativeDefault" as const,
        workClass: "standard" as const,
      }
    : classifyPrompt(input.prompt);
  const inherited = classification.classificationReason ===
      "continuationOrAmbiguous" && input.requiredInputClass === "text" &&
      input.priorRouting != null
    ? {
        classificationReason: "continuationInherited" as const,
        workClass: input.priorRouting.workClass,
        requestedProfile: input.priorRouting.requestedProfile,
        requestedServiceTier: input.priorRouting.requestedServiceTier,
      }
    : null;
  const classificationReason = inherited?.classificationReason ??
    classification.classificationReason;
  const workClass = inherited?.workClass ?? classification.workClass;
  return Object.freeze(chatRootTurnRoutingProjectionSchema.parse({
    policyVersion: ROOT_TURN_ROUTING_POLICY_VERSION,
    classificationReason,
    workClass,
    requestedProfile: inherited?.requestedProfile ?? requestedProfile(workClass),
    selectedProfile: null,
    profileFallbackReason: null,
    requestedServiceTier: inherited?.requestedServiceTier ??
      requestedServiceTier(classificationReason),
    selectedServiceTier: null,
    serviceTierFallbackReason: null,
  }));
}
