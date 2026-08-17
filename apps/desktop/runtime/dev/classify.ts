import {
  parseAndClassifyDevChange,
  parseRepositoryRelativePath,
  type DevChangeClassification,
} from "./change-classifier.ts";

export interface DevChangeSummary {
  readonly lane: "ignored" | "live" | "staged" | "restart";
  readonly reason: string;
}

export function summarizeDevChange(
  classification: DevChangeClassification,
): DevChangeSummary {
  switch (classification.kind) {
    case "ignored":
      return { lane: "ignored", reason: "documentation or test" };
    case "frontendLive":
      return { lane: "live", reason: "Vite HMR" };
    case "gatewayReload":
      return { lane: "staged", reason: "gateway apply" };
    case "restartRequired":
      return classification.target === "native"
        ? { lane: "restart", reason: "native host boundary" }
        : { lane: "restart", reason: "launcher or cold boundary" };
  }
}

export function classifyDevPathLine(value: unknown): string {
  const path = parseRepositoryRelativePath(value);
  const summary = summarizeDevChange(parseAndClassifyDevChange(path));
  return `${path}\t${summary.lane}\t${summary.reason}`;
}

if (import.meta.main) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("Usage: bun run dev:classify -- <repository-relative-path> [...]");
    process.exitCode = 1;
  } else {
    try {
      for (const path of paths) console.log(classifyDevPathLine(path));
    } catch {
      console.error("Every development path must be a strict repository-relative POSIX path.");
      process.exitCode = 1;
    }
  }
}
