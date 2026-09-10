import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { Badge } from "./ui/badge";
import { EmptyRow, SettingsCard, SettingsSection } from "./settings-list";
import { useUsageOverview, type UsageAccountView } from "../data/usage";
import { formatRelativeTime } from "../model/relative-time";
import {
  formatDurationUntil,
  formatTokenRate,
  outlookSentence,
  providerUsageRollup,
  type AccountUsageSummary,
  type BindingWindow,
  type UsageObservation,
} from "../model/usage-meter";
import type { UsageLimit, UsageWindow } from "../oompa/cloud";
import { usageBreakdownStyles } from "./usage-breakdown.stylex";

const chartWidth = 240;
const chartHeight = 40;

/**
 * Points for the used-percent sparkline of the binding window, oldest first,
 * as SVG coordinates. Attributes, never inline styles: the app's CSP refuses
 * `style` and this stays a plain drawing.
 */
export function sparklinePoints(
  history: readonly UsageObservation[],
  binding: BindingWindow | null,
): string {
  if (binding === null) return "";
  const samples = [...history]
    .sort((left, right) => left.observedAt - right.observedAt)
    .flatMap((observation) => {
      if (observation.projection.state !== "ready") return [];
      const limit = observation.projection.data.limits.find((entry) => entry.id === binding.limitId);
      const window = [limit?.primary ?? null, limit?.secondary ?? null].find((candidate) =>
        candidate !== null
        && candidate.windowDurationMinutes === binding.windowDurationMinutes
        && candidate.resetsAt === binding.resetsAt);
      return window === null || window === undefined ? [] : [window.usedPercent];
    });
  if (samples.length < 2) return "";
  const step = chartWidth / (samples.length - 1);
  return samples
    .map((used, index) => `${(index * step).toFixed(1)},${(chartHeight - (used / 100) * chartHeight).toFixed(1)}`)
    .join(" ");
}

function windowLabel(window: UsageWindow): string {
  const minutes = window.windowDurationMinutes;
  if (minutes % 1_440 === 0) return `${String(minutes / 1_440)}d window`;
  if (minutes % 60 === 0) return `${String(minutes / 60)}h window`;
  return `${String(minutes)}m window`;
}

function WindowRow({ now, window }: Readonly<{ now: number; window: UsageWindow }>): ReactNode {
  const used = Math.round(window.usedPercent);
  return (
    <div {...stylex.props(usageBreakdownStyles.windowRow)}>
      <span {...stylex.props(usageBreakdownStyles.windowLabel)}>{windowLabel(window)}</span>
      <meter
        aria-label={`${windowLabel(window)}: ${String(used)} percent used`}
        {...stylex.props(usageBreakdownStyles.meter)}
        high={80}
        low={50}
        max={100}
        min={0}
        optimum={0}
        value={used}
      />
      <span {...stylex.props(usageBreakdownStyles.windowFacts)}>
        {`${String(used)}% used · resets in ${formatDurationUntil(window.resetsAt, now)}`}
      </span>
    </div>
  );
}

function LimitRows({ limit, now }: Readonly<{ limit: UsageLimit; now: number }>): ReactNode {
  return (
    <div {...stylex.props(usageBreakdownStyles.limit)}>
      <div {...stylex.props(usageBreakdownStyles.limitHeader)}>
        <span {...stylex.props(usageBreakdownStyles.limitName)}>{limit.name}</span>
        {limit.reached ? <Badge tone="danger">Limit reached</Badge> : null}
        {limit.unlimited ? <Badge tone="neutral">Unlimited</Badge> : null}
      </div>
      {limit.primary === null ? null : <WindowRow now={now} window={limit.primary} />}
      {limit.secondary === null ? null : <WindowRow now={now} window={limit.secondary} />}
    </div>
  );
}

function summaryFacts(summary: AccountUsageSummary, now: number): readonly string[] {
  const facts: string[] = [];
  if (summary.resetCredits !== null) {
    facts.push(`${String(summary.resetCredits)} reset credit${summary.resetCredits === 1 ? "" : "s"}`);
  }
  if (summary.rate?.tokensPerMinute !== null && summary.rate?.tokensPerMinute !== undefined) {
    facts.push(formatTokenRate(summary.rate.tokensPerMinute));
  }
  if (summary.rate !== null) facts.push(`${summary.rate.percentPerHour.toFixed(1)}% per hour`);
  if (summary.outlook.kind === "running_out" || summary.outlook.kind === "surplus") {
    facts.push(`empty in ${formatDurationUntil(summary.outlook.exhaustsAt, now)} at this pace`);
  }
  facts.push(`observed ${formatRelativeTime(summary.observedAt, now)}`);
  return facts;
}

function AccountCard({ account, now, ready }: Readonly<{
  account: UsageAccountView;
  now: number;
  ready: boolean;
}>): ReactNode {
  const newest = [...account.history].sort((left, right) => right.observedAt - left.observedAt)[0];
  const summary = account.summary;
  const title = account.metadata?.label ?? account.publicId;
  const subtitle = account.metadata === null
    ? null
    : [account.metadata.email, account.metadata.plan].filter((part) => part !== null).join(" · ");
  return (
    <div {...stylex.props(usageBreakdownStyles.account)}>
      <div {...stylex.props(usageBreakdownStyles.accountHeader)}>
        <span {...stylex.props(usageBreakdownStyles.accountTitle)}>{title}</span>
        {subtitle === null ? null : <span {...stylex.props(usageBreakdownStyles.quiet)}>{subtitle}</span>}
      </div>
      {!ready ? (
        <p {...stylex.props(usageBreakdownStyles.quiet)}>Waiting for hosted time.</p>
      ) : summary === null ? (
        <p {...stylex.props(usageBreakdownStyles.quiet)}>
          {newest === undefined
            ? "No usage observed yet."
            : newest.projection.state === "loading"
              ? "The machine is still reading this account's usage."
              : "The last usage read failed on the machine."}
        </p>
      ) : (
        <>
          <p {...stylex.props(usageBreakdownStyles.outlook)}>
            {`${String(Math.round(summary.remainingPercent))}% left. ${outlookSentence(providerUsageRollup([summary]), now)}`}
          </p>
          <p {...stylex.props(usageBreakdownStyles.quiet)}>{summaryFacts(summary, now).join(" · ")}</p>
          {sparklinePoints(account.history, summary.binding).length === 0 ? null : (
            <svg
              aria-label="Binding window use over recent observations"
              {...stylex.props(usageBreakdownStyles.chart)}
              preserveAspectRatio="none"
              role="img"
              viewBox={`0 0 ${String(chartWidth)} ${String(chartHeight)}`}
            >
              <polyline
                fill="none"
                points={sparklinePoints(account.history, summary.binding)}
                stroke="currentColor"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          )}
          {newest?.projection.state === "ready"
            ? newest.projection.data.limits.map((limit) => (
                <LimitRows key={limit.id} limit={limit} now={now} />
              ))
            : null}
        </>
      )}
    </div>
  );
}

/**
 * The detailed usage breakdown on the settings screen: one card per Codex
 * account across every machine, with each limit's windows, reset times,
 * reset credits, throughput, the runway at the current pace, and a short
 * history of the binding window.
 */
export function UsageBreakdown(): ReactNode {
  const overview = useUsageOverview();
  return (
    <div id="usage">
      <SettingsSection
        description="Remaining Codex usage across every account and machine. Each machine reports what its provider shows; nothing here spends a reset credit."
        title="Usage"
      >
        <SettingsCard>
          {overview.loading ? <EmptyRow>Loading usage.</EmptyRow> : null}
          {!overview.loading && overview.accounts.length === 0
            ? <EmptyRow>No account has reported usage yet. Sign in to Codex on a machine and let it sync once.</EmptyRow>
            : null}
          {overview.accounts.map((account) => (
            <AccountCard account={account} key={account.publicId} now={overview.now} ready={overview.ready} />
          ))}
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
