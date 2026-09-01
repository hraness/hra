#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { join } from "node:path";

import { resolvedCodexHome } from "./shared";

type SessionOptions = {
  readonly codexHome: string;
  readonly json: boolean;
  readonly limit: number;
  readonly staleHours: number;
};

type ThreadRow = {
  readonly agent_role: string | null;
  readonly cwd: string;
  readonly id: string;
  readonly is_pinned: number;
  readonly source: string;
  readonly title: string;
  readonly updated_at_ms: number;
};

export type SessionThread = ThreadRow & {
  readonly reviewKind: "pinned-review-candidate" | "review-candidate";
  readonly silentHours: number;
};

const titleLimit = 120;
const cwdLimit = 240;
const sourceLimit = 120;

function boundedSingleLine(value: string, limit: number): string {
  const sanitized = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f) ? " " : character;
  }).join("").replace(/\s+/gu, " ").trim();
  const characters = Array.from(sanitized);
  return characters.length <= limit
    ? sanitized
    : `${characters.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

function publicThread(row: ThreadRow, now: number): SessionThread {
  return {
    ...row,
    agent_role: row.agent_role === null ? null : boundedSingleLine(row.agent_role, 80),
    cwd: boundedSingleLine(row.cwd, cwdLimit),
    id: boundedSingleLine(row.id, 80),
    source: boundedSingleLine(row.source, sourceLimit),
    title: boundedSingleLine(row.title, titleLimit),
    reviewKind: row.is_pinned === 0 ? "review-candidate" : "pinned-review-candidate",
    silentHours: Math.round((now - row.updated_at_ms) / 3_600_000 * 10) / 10,
  };
}

export function parseSessionArguments(arguments_: readonly string[]): SessionOptions {
  let codexHome = resolvedCodexHome();
  let json = false;
  let limit = 30;
  let staleHours = 24;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--json") json = true;
    else if (argument?.startsWith("--stale-hours=")) {
      staleHours = Number(argument.slice("--stale-hours=".length));
    } else if (argument?.startsWith("--limit=")) {
      limit = Number(argument.slice("--limit=".length));
    } else if (argument === "--codex-home") {
      const value = arguments_[index + 1];
      if (value === undefined || !value.startsWith("/")) {
        throw new Error("--codex-home requires an absolute path");
      }
      codexHome = value;
      index += 1;
    } else throw new Error(`unknown session-audit argument: ${argument}`);
  }
  if (!Number.isFinite(staleHours) || staleHours <= 0) {
    throw new Error("--stale-hours must be positive");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("--limit must be an integer from 1 through 500");
  }
  return { codexHome, json, limit, staleHours };
}

export function auditSessions(options: SessionOptions, now = Date.now()): {
  readonly cutoff: string;
  readonly pinnedSilentCount: number;
  readonly silent: readonly SessionThread[];
  readonly silentCount: number;
  readonly supportTaskCount: number;
  readonly statusAuthority: "heuristic-only";
  readonly userTaskCount: number;
  readonly version: 2;
} {
  const path = join(options.codexHome, "state_5.sqlite");
  const database = new Database(path, { readonly: true, strict: true });
  try {
    const columns = new Set(database.query<{ readonly name: string }, []>(
      "PRAGMA table_info(threads)",
    ).all().map((column) => column.name));
    const supportPredicate = columns.has("thread_source")
      ? `(COALESCE(thread_source, '') NOT IN ('', 'user') OR source LIKE '{"subagent":%')`
      : `source LIKE '{"subagent":%'`;
    const pinnedTerms = [
      ...(columns.has("is_pinned") ? ["is_pinned = 1"] : []),
      ...(columns.has("thread_section_id") ? ["thread_section_id IS NOT NULL"] : []),
    ];
    const pinnedPredicate = pinnedTerms.length === 0 ? "0" : `(${pinnedTerms.join(" OR ")})`;
    const updatedExpression = columns.has("updated_at_ms")
      ? "updated_at_ms"
      : columns.has("updated_at") ? "updated_at * 1000" : null;
    if (updatedExpression === null) throw new Error("threads table lacks an update timestamp");
    const visiblePredicate = columns.has("preview") ? "preview <> ''" : "1 = 1";
    const agentRoleExpression = columns.has("agent_role") ? "agent_role" : "NULL AS agent_role";
    const totals = database.query<{
      readonly support_count: number;
      readonly user_count: number;
    }, []>(
      `SELECT
         COALESCE(SUM(CASE WHEN ${supportPredicate} THEN 1 ELSE 0 END), 0) AS support_count,
         COALESCE(SUM(CASE WHEN ${supportPredicate} THEN 0 ELSE 1 END), 0) AS user_count
       FROM threads
       WHERE archived = 0 AND ${visiblePredicate}`,
    ).get() ?? { support_count: 0, user_count: 0 };
    const cutoffMs = now - options.staleHours * 60 * 60_000;
    const counts = database.query<{
      readonly count: number;
      readonly pinned_count: number;
    }, [number]>(
      `SELECT
         COUNT(*) AS count,
         COALESCE(SUM(CASE WHEN ${pinnedPredicate} THEN 1 ELSE 0 END), 0) AS pinned_count
       FROM threads
       WHERE archived = 0
         AND ${visiblePredicate}
         AND NOT (${supportPredicate})
         AND ${updatedExpression} < ?`,
    ).get(cutoffMs) ?? { count: 0, pinned_count: 0 };
    const rows = database.query<ThreadRow, [number, number]>(
      `SELECT id, title, cwd, source, ${agentRoleExpression},
              CASE WHEN ${pinnedPredicate} THEN 1 ELSE 0 END AS is_pinned,
              ${updatedExpression} AS updated_at_ms
       FROM threads
       WHERE archived = 0
         AND ${visiblePredicate}
         AND NOT (${supportPredicate})
         AND ${updatedExpression} < ?
       ORDER BY ${updatedExpression} ASC
       LIMIT ?`,
    ).all(cutoffMs, options.limit);
    return {
      cutoff: new Date(cutoffMs).toISOString(),
      pinnedSilentCount: counts.pinned_count,
      silent: rows.map((row) => publicThread(row, now)),
      silentCount: counts.count,
      supportTaskCount: totals.support_count,
      statusAuthority: "heuristic-only",
      userTaskCount: totals.user_count,
      version: 2,
    };
  } finally {
    database.close();
  }
}

if (import.meta.main) {
  try {
    const options = parseSessionArguments(process.argv.slice(2));
    const result = auditSessions(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(
        `SESSIONS\tuser=${result.userTaskCount}\tsupport=${result.supportTaskCount}`
        + `\tsilent=${result.silentCount}\tpinned-silent=${result.pinnedSilentCount}`
        + `\tcutoff=${result.cutoff}`,
      );
      for (const thread of result.silent) {
        console.log(
          (thread.is_pinned === 0 ? "REVIEW-CANDIDATE" : "PINNED-REVIEW-CANDIDATE")
          + `\t${thread.silentHours}h\t${thread.id}\t${thread.cwd}\t${thread.title}`,
        );
      }
      console.log("NOTE\tSilence is a review heuristic, not proof that a task is running, terminal, or abandoned.");
      console.log("NOTE\tSupport-task rows are historical coordination metadata, not proof of active compute.");
      console.log("NOTE\tVerify authoritative app task status before archiving; this audit never mutates SQLite.");
    }
  } catch (error) {
    console.error(`[hra-session-audit] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
