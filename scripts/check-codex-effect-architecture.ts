import { resolve } from "node:path";

import { createArchitectureProgram, inspectEffectArchitecture } from "./check-effect-architecture.ts";

const root = resolve(import.meta.dir, "..");
const findings = inspectEffectArchitecture(createArchitectureProgram(resolve(root, "tsconfig.json")), {
  root,
  modules: [
    "src/codex/session-program.ts",
    "src/codex/session-effects.ts",
    "src/claude/client.ts",
    "src/claude/session-model.ts",
    "src/claude/session-platform.ts",
    "src/claude/session-program.ts",
    "src/claude/session-effects.ts",
    "src/daemon/claude-runtime-adapter.ts",
    "src/daemon/claude-runtime-program.ts",
  ],
  adapters: [
    "src/codex/session-effects.ts",
    // Owns native Promise projection at the prepared interpreter's public edge.
    "src/claude/session-effects.ts",
    "src/claude/session-platform.ts",
    "src/daemon/claude-runtime-adapter.ts",
  ],
  runtimeRoots: ["src/codex/session-effects.ts", "src/claude/session-effects.ts"],
  ignoredDirectories: ["scripts"],
});
for (const finding of findings) {
  console.error(`${finding.file}:${String(finding.line)} ${finding.rule}: ${finding.message}`);
}
if (findings.length > 0) process.exitCode = 1;
