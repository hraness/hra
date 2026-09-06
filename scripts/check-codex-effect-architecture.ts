import { resolve } from "node:path";

import { createArchitectureProgram, inspectEffectArchitecture } from "./check-effect-architecture.ts";

const root = resolve(import.meta.dir, "..");
const findings = inspectEffectArchitecture(createArchitectureProgram(resolve(root, "tsconfig.json")), {
  root,
  modules: ["src/codex/session-program.ts", "src/codex/session-effects.ts"],
  adapters: ["src/codex/session-effects.ts"],
  runtimeRoots: ["src/codex/session-effects.ts"],
  ignoredDirectories: ["scripts"],
});
for (const finding of findings) {
  console.error(`${finding.file}:${String(finding.line)} ${finding.rule}: ${finding.message}`);
}
if (findings.length > 0) process.exitCode = 1;
