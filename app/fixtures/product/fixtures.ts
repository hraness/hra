import type { SessionHead } from "../../src/data/wire";
import type { SessionModelView } from "../../src/data/session-model-hook";
import type { DeviceRegistries } from "../../src/data/registry";
import {
  parseCompactSessionEvent, parseDetailSessionEvent, parseDeviceRegistryPayload,
  type CompactSessionEvent, type DetailSessionEvent, type DeviceRegistryPayload,
} from "../../src/hra/cloud";
import { initialSessionModel, sessionModelReducer } from "../../src/model/session-model";
import { toMachineView } from "../../src/model/settings-view";

export const PRODUCT_PREVIEW_NOW = Date.parse("2026-09-08T12:00:00.000Z");
export const PRODUCT_SESSION_IDS = Object.freeze({
  conversation: "session_example_checkout",
  question: "session_example_export",
  completed: "session_example_migration",
});
const devicePublicId = "device_example_studio";
const secondDevicePublicId = "device_example_linux";
const questionId = "019927f8-7200-7000-8000-000000000001";

function compact(event: CompactSessionEvent): CompactSessionEvent {
  const parsed = parseCompactSessionEvent(event);
  if (parsed === null) throw new Error("Invalid compact product example.");
  return parsed;
}

function detail(event: DetailSessionEvent): DetailSessionEvent {
  const parsed = parseDetailSessionEvent(event);
  if (parsed === null) throw new Error("Invalid detail product example.");
  return parsed;
}

function session(input: Readonly<{
  events: readonly CompactSessionEvent[];
  details: readonly DetailSessionEvent[];
  title: string;
}>): SessionModelView {
  const compactEvents = input.events.map(compact);
  const details = input.details.map(detail);
  const liveModel = sessionModelReducer(initialSessionModel(), { events: details, type: "detail" });
  let model = sessionModelReducer(initialSessionModel(), { events: compactEvents, type: "compact" });
  model = sessionModelReducer(model, { events: details, type: "detail" });
  model = sessionModelReducer(model, { name: input.title, type: "metadata" });
  return { compactEvents, historyLoading: false, liveModel, metadata: { archived: false, name: input.title, note: null }, model };
}

function state(state: "working" | "needs_answer" | "done", now: number, sequence: number): DetailSessionEvent {
  return {
    attention: state === "needs_answer", lastActivityAt: now, reason: "Fictional product example",
    revision: 1, sequence, state, type: "session_state", verbatimRequired: false,
  };
}

function registry(payload: DeviceRegistryPayload): DeviceRegistryPayload {
  const parsed = parseDeviceRegistryPayload(payload);
  if (parsed === null) throw new Error("Invalid machine product example.");
  return parsed;
}

/** Synthetic observations, parsed and folded by the same contracts as the app. */
export function createProductObservations(now: number) {
  if (now !== PRODUCT_PREVIEW_NOW) throw new Error("Product examples require their fixed clock.");
  const heads: readonly SessionHead[] = Object.values(PRODUCT_SESSION_IDS).map((publicId, index) => ({
    compactHeadSequence: 3, compactStreamEpoch: 1, createdAt: now - 600_000,
    detailHeadSequence: 4, detailStreamEpoch: 1, executionDevicePublicId: devicePublicId,
    metadata: null, metadataRevision: 1, projectionRevision: 1, publicId,
    state: publicId === PRODUCT_SESSION_IDS.completed ? "idle" : "active", updatedAt: now - index * 60_000,
  }));
  const models: Readonly<Record<string, SessionModelView>> = Object.freeze({
    [PRODUCT_SESSION_IDS.conversation]: session({
      title: "Polish the checkout",
      events: [
        { kind: "user_message", sequence: 1, text: "Make the checkout easier to read on a phone. Keep the existing payment flow.", turnId: "example_checkout_first" },
        { kind: "assistant_message", sequence: 2, text: "I found two useful changes:\n\n- Keep the order total visible.\n- Put the delivery options before payment.\n\nThe payment integration can stay as it is.", turnId: "example_checkout_first" },
        { kind: "user_message", sequence: 3, text: "Go ahead. Keep the layout compact and check the small-screen states.", turnId: "example_checkout_current" },
      ],
      details: [
        { at: now - 45_000, sequence: 1, turnId: "example_checkout_current", type: "turn_started" },
        { sequence: 2, text: "The compact layout is in place. I’m checking the empty cart, delivery choices, and payment error state next.", turnId: "example_checkout_current", type: "assistant_delta" },
        { agentId: "agent_example_review", depth: 1, kind: "started", nickname: "Reviewer", role: "Small-screen review", sequence: 3, turnId: "example_checkout_current", type: "subagent_activity" },
        state("working", now - 15_000, 4),
      ],
    }),
    [PRODUCT_SESSION_IDS.question]: session({
      title: "Choose the export format",
      events: [
        { kind: "user_message", sequence: 1, text: "Add an export for the monthly project summary.", turnId: "example_export" },
        { kind: "assistant_message", sequence: 2, text: "The summary is ready to export. One choice affects how people will use the file.", turnId: "example_export" },
        {
          blocking: true, detailVersion: 2, headline: "Which format should the export use?",
          interactionId: questionId, interactionKind: "user_input", kind: "interaction_state", label: "Question",
          remotePolicy: {
            actions: ["answer"], deadlineAt: now + 600_000, reasonCodes: [], version: 2,
            questions: [{ allowsOther: false, header: "Export format", id: "format", kind: "user_input",
              options: [{ description: "Open the summary in a spreadsheet.", label: "CSV" }, { description: "Use the summary in another tool.", label: "JSON" }],
              question: "Which format should the export use?" }],
          },
          revision: 1, sequence: 3, state: "pending", summary: "Choose one of the two supported export formats.",
        },
      ],
      details: [state("needs_answer", now - 5_000, 1)],
    }),
    [PRODUCT_SESSION_IDS.completed]: session({
      title: "Review the migration",
      events: [
        { kind: "user_message", sequence: 1, text: "Review the migration and its rollback coverage.", turnId: "example_migration" },
        { kind: "assistant_message", sequence: 2, text: "Review complete. The migration preserves existing rows, and the rollback cases are covered.\n\nNo changes needed.", turnId: "example_migration" },
        { filesTouched: [], gitActions: [], kind: "turn_summary", runtimeMs: 84_000, sequence: 3, turnId: "example_migration" },
      ],
      details: [state("done", now - 180_000, 1)],
    }),
  });
  const adoption = {
    claude: { adopted: 0, enabled: false, fenced: 0, pending: 0 },
    codex: { adopted: 0, enabled: false, fenced: 0, pending: 0 },
  };
  const primary = registry({
    accountLinkingAllowed: false,
    accounts: [{ label: "Work", provider: "codex", publicId: "account_example_codex", status: "signed_in" }],
    daemonVersion: "0.7.0", defaultApprovalMode: "auto:workspace", defaultPreset: "ultra", deviceCommandsAllowed: true,
    heartbeatAt: now - 20_000, machineLabel: "Studio Mac", projects: [{ label: "Storefront", publicId: "project_example_storefront" }],
    proseAutorespondConfigured: false,
    scheduledTasks: [{ cadence: "Every weekday at 09:00", id: "task_example_review", kind: "hra_conversation", label: "Morning review", nextRunAt: now + 86_400_000, sessionPublicId: PRODUCT_SESSION_IDS.completed }],
    sessionAdoption: adoption, showThinkingDefault: false, version: 1,
  });
  const secondary = registry({
    ...primary, accounts: [{ label: "Personal", provider: "claude", publicId: "account_example_claude", status: "signed_in" }],
    defaultPreset: "fable-max", heartbeatAt: now - 3_600_000, machineLabel: "Linux workstation", scheduledTasks: [],
  });
  const machines = [primary, secondary].map((payload, index) => toMachineView({
    attentionEmailEnabled: false, device: { online: index === 0, status: "active" },
    devicePublicId: index === 0 ? devicePublicId : secondDevicePublicId,
    memorySummaryReady: true, memorySummary: null, memorySummaryStatus: "unsupported",
    notificationHours: { endMinute: 1_080, revision: 1, startMinute: 540, timeZone: "America/Puerto_Rico", version: 1 },
    notificationHoursStatus: "available", notificationPolicyFreshness: "current", notificationPolicyRevision: 1,
    now, payload, revision: 1, updatedAt: payload.heartbeatAt,
  }));
  const registries: DeviceRegistries = { error: null, loading: false, machines, memorySummaryReady: true, now };
  return Object.freeze({ heads, models, registries });
}
