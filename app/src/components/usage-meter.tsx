import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { useUsageOverview } from "../data/usage";
import {
  formatDurationUntil,
  formatTokenRate,
  outlookSentence,
  type ProviderUsageRollup,
} from "../model/usage-meter";
import { navigate } from "../routing/router";
import { usageRoute } from "../routing/route";
import { usageMeterStyles } from "./usage-meter.stylex";

/** The meter's remaining value, rounded for the bar and the label. */
export function meterPercent(rollup: ProviderUsageRollup): number {
  return Math.round(Math.max(0, Math.min(100, rollup.remainingPercent)));
}

/** The facts the compact meter lists after the bar, in reading order. */
export function meterFacts(rollup: ProviderUsageRollup, now: number): readonly string[] {
  const facts: string[] = [];
  if (rollup.nextResetAt !== null) facts.push(`resets in ${formatDurationUntil(rollup.nextResetAt, now)}`);
  if (rollup.resetCredits !== null) {
    facts.push(`${String(rollup.resetCredits)} reset${rollup.resetCredits === 1 ? "" : "s"} left`);
  }
  if (rollup.tokensPerMinute !== null) facts.push(formatTokenRate(rollup.tokensPerMinute));
  if (rollup.unknown > 0) facts.push(`${String(rollup.unknown)} unknown`);
  if (rollup.stale) facts.push("stale");
  return facts;
}

/**
 * The compact usage meter on the grid: what is left across every Codex
 * account on every machine, when it frees up, how fast it is going, and
 * whether the reset or the limit comes first. It is one button; the detailed
 * breakdown lives in Settings.
 */
export function UsageMeter(): ReactNode {
  const overview = useUsageOverview();
  if (overview.loading || overview.accounts.length === 0) return null;
  const rollup = overview.codex;
  const percent = meterPercent(rollup);
  const facts = overview.ready ? meterFacts(rollup, overview.now) : ["syncing clock"];
  const sentence = overview.ready ? outlookSentence(rollup, overview.now) : "Waiting for hosted time.";
  return (
    <button
      aria-label={`Codex usage: ${String(percent)} percent left. ${sentence} Open the usage breakdown.`}
      {...stylex.props(usageMeterStyles.root)}
      onClick={() => { navigate(usageRoute); }}
      type="button"
    >
      <span {...stylex.props(usageMeterStyles.provider)}>Codex</span>
      <meter
        aria-hidden="true"
        {...stylex.props(usageMeterStyles.meter)}
        high={50}
        low={20}
        max={100}
        min={0}
        optimum={100}
        value={percent}
      />
      <span {...stylex.props(usageMeterStyles.percent)}>{`${String(percent)}% left`}</span>
      <span {...stylex.props(usageMeterStyles.facts)}>
        {facts.map((fact) => <span key={fact}>{fact}</span>)}
      </span>
      <span {...stylex.props(usageMeterStyles.outlook, outlookStyle(rollup))}>{sentence}</span>
    </button>
  );
}

function outlookStyle(rollup: ProviderUsageRollup) {
  switch (rollup.outlook) {
    case "exhausted":
    case "running_out":
      return usageMeterStyles.danger;
    case "surplus":
      return usageMeterStyles.accent;
    case "steady":
    case "unlimited":
      return null;
  }
}
