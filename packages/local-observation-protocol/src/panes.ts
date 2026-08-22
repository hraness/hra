import { z } from "@hra-internal/schema";

import {
  boundedObservationCountSchema,
  localDisplayNameSchema,
  localObservationVersion,
  localPaneIdSchema,
  workspaceRecoveryKindSchema,
} from "./attention";

export const localPaneListLimit = 64;

const canonicalDateTimeSchema = z.string().length(24).datetime().refine((value) => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}, "timestamp must use canonical millisecond UTC form");

export const localPaneSummarySchema = z.object({
  paneId: localPaneIdSchema,
  title: localDisplayNameSchema,
  repositoryName: localDisplayNameSchema,
  interactionMode: z.enum(["chat", "harnessObserver"]),
  state: z.enum(["ready", "starting", "streaming", "continuing", "attention"]),
  workspace: z.object({
    state: z.enum([
      "preparing",
      "waitingCapacity",
      "ready",
      "preserved",
      "recoveryRequired",
    ]),
    recoveryKind: workspaceRecoveryKindSchema.nullable(),
  }).strict().nullable(),
  queue: z.object({
    count: boundedObservationCountSchema,
    paused: z.boolean(),
    blocked: z.boolean(),
  }).strict().superRefine((queue, context) => {
    if (queue.blocked && !queue.paused) {
      context.addIssue({
        code: "custom",
        message: "a blocked queue must also be paused",
        path: ["paused"],
      });
    }
  }),
  schedule: z.object({ nextRunAt: canonicalDateTimeSchema }).strict().nullable(),
}).strict().superRefine((pane, context) => {
  if ((pane.interactionMode === "chat") !== (pane.workspace !== null)) {
    context.addIssue({
      code: "custom",
      message: "only ordinary chat panes carry workspace state",
      path: ["workspace"],
    });
  }
  if (pane.interactionMode !== "chat" && pane.schedule !== null) {
    context.addIssue({
      code: "custom",
      message: "only ordinary chat panes carry schedules",
      path: ["schedule"],
    });
  }
});

export const localPaneListProjectionSchema = z.object({
  version: z.literal(localObservationVersion),
  panes: z.array(localPaneSummarySchema).max(localPaneListLimit),
  truncated: z.boolean(),
}).strict().superRefine((projection, context) => {
  const ids = new Set<string>();
  projection.panes.forEach((pane, index) => {
    if (ids.has(pane.paneId)) {
      context.addIssue({
        code: "custom",
        message: "pane summaries require unique pane IDs",
        path: ["panes", index, "paneId"],
      });
    }
    ids.add(pane.paneId);
  });
});

export type LocalPaneSummary = z.infer<typeof localPaneSummarySchema>;
export type LocalPaneListProjection = z.infer<typeof localPaneListProjectionSchema>;

export function canonicalLocalPaneListProjection(value: unknown): LocalPaneListProjection {
  return localPaneListProjectionSchema.parse(value);
}
