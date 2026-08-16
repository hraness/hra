import type { AccountSummary } from "../../contracts/runtime";

/**
 * Gateway-only Codex capacity state. These values are intentionally defined
 * below the native renderer boundary: they may guide local dispatch routing,
 * but they can never be parsed by the WebView contract.
 */
export type AccountTokenUsageState =
  | Readonly<{ readonly state: "unavailable" }>
  | Readonly<{ readonly state: "loading" }>
  | Readonly<{
      readonly state: "ready";
      readonly lifetimeTokens: string | null;
      readonly peakDailyTokens: string | null;
      readonly longestRunningTurnSeconds: string | null;
      readonly currentStreakDays: string | null;
      readonly longestStreakDays: string | null;
      readonly daily: readonly Readonly<{
        readonly startDate: string;
        readonly tokens: string;
      }>[];
      readonly updatedAt: string;
    }>
  | Readonly<{ readonly state: "failed"; readonly message: string }>;

export interface RateLimitWindowSummary {
  readonly usedPercent: number;
  readonly windowDurationMinutes: number | null;
  readonly resetsAt: string | null;
}

export interface RateLimitSummary {
  readonly id: string;
  readonly name: string;
  readonly primary: RateLimitWindowSummary | null;
  readonly secondary: RateLimitWindowSummary | null;
  readonly individual: Readonly<{
    readonly remainingPercent: number;
    readonly resetsAt: string;
  }> | null;
  readonly unlimited: boolean;
  readonly reached: boolean;
}

export type AccountUsageState =
  | Readonly<{ readonly state: "unavailable" }>
  | Readonly<{ readonly state: "loading" }>
  | Readonly<{
      readonly state: "ready";
      readonly limits: readonly RateLimitSummary[];
      readonly tokens: AccountTokenUsageState;
      readonly updatedAt: string;
    }>
  | Readonly<{ readonly state: "failed"; readonly message: string }>;

export type DispatchAccountSummary = AccountSummary & Readonly<{
  readonly usage: AccountUsageState;
}>;

/** Private gateway routing material. Never project provider headroom to the renderer. */
export interface ChatAccountRoutingCandidate {
  readonly id: AccountSummary["id"];
  readonly selected: boolean;
  readonly budget: "healthy" | "low" | "exhausted" | "unknown";
  /** Fresh normalized provider headroom, or null when no exact evidence exists. */
  readonly remainingPercent: number | null;
}

/** Gateway-owned work/session identities. Never export these from contracts/. */
export interface ProjectSummary {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly displayPath: string;
  readonly registeredAt: string;
}

export interface WorkspaceLaneSummary {
  readonly id: string;
  readonly revision: number;
  readonly projectId: string;
  readonly mode: "managed" | "local" | "readOnly";
  readonly status:
    | "provisioning"
    | "setupPending"
    | "settingUp"
    | "ready"
    | "setupFailed"
    | "missing"
    | "preserved"
    | "released";
  readonly displayPath: string;
  readonly dirty: boolean;
  readonly preserved: boolean;
}

export interface TurnSummary {
  readonly id: string;
  readonly revision: number;
  readonly status: "starting" | "active" | "interrupted" | "failed" | "completed";
  readonly startedAt: string;
  readonly completedAt: string | null;
}

export interface ThreadSummary {
  readonly id: string;
  readonly revision: number;
  readonly accountProfileId: string;
  readonly projectId: string;
  readonly workspaceLaneId: string;
  readonly title: string;
  readonly status: "idle" | "active" | "waiting" | "interrupted" | "failed" | "archived";
  readonly activeTurn: TurnSummary | null;
  readonly attentionCount: number;
  readonly updatedAt: string;
}

interface TimelineItemCommon {
  readonly id: string;
  readonly revision: number;
  readonly threadId: string;
  readonly turnId: string;
}

export type TimelineItem =
  | (TimelineItemCommon & Readonly<{
      readonly kind: "message";
      readonly status: "streaming" | "completed" | "failed";
      readonly role: "user" | "assistant";
      readonly text: string;
    }>)
  | (TimelineItemCommon & Readonly<{
      readonly kind: "reasoning";
      readonly status: "streaming" | "completed" | "failed";
      readonly text: string;
    }>)
  | (TimelineItemCommon & Readonly<{
      readonly kind: "command";
      readonly status: "running" | "completed" | "failed" | "declined";
      readonly summary: string;
      readonly output: string;
      readonly exitCode: number | null;
    }>)
  | (TimelineItemCommon & Readonly<{
      readonly kind: "fileChange";
      readonly status: "proposed" | "completed" | "failed" | "declined";
      readonly summary: string;
      readonly paths: readonly string[];
    }>);

export type GatewaySessionEvent =
  | Readonly<{ readonly type: "project.upserted"; readonly project: ProjectSummary }>
  | Readonly<{ readonly type: "workspace.upserted"; readonly workspaceLane: WorkspaceLaneSummary }>
  | Readonly<{ readonly type: "thread.upserted"; readonly thread: ThreadSummary }>
  | Readonly<{ readonly type: "thread.removed"; readonly threadId: string }>
  | Readonly<{
      readonly type: "item.delta";
      readonly itemId: string;
      readonly threadId: string;
      readonly turnId: string;
      readonly revision: number;
      readonly channel: "text" | "reasoning" | "commandOutput";
      readonly delta: string;
    }>
  | Readonly<{ readonly type: "item.upserted"; readonly item: TimelineItem }>;
