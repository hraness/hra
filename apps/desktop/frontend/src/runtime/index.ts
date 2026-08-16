import { detectRuntimeBridge } from "../runtime-bridge";
import { createRuntimeShell, type RuntimeShell } from "./shell";


export { applyRuntimeEvent, type RuntimeProjectionResult } from "./projection";
export {
  createRuntimeShell,
  type RuntimeShell,
  type RuntimeShellFailure,
  type RuntimeShellOptions,
  type RuntimeShellState,
} from "./shell";
export {
  useRuntimeShellSelector,
  type RuntimeShellSelectionEquality,
  type RuntimeShellSelector,
} from "./use-runtime-shell-selector";

export function detectRuntimeShell(): RuntimeShell | null {
  const bridge = detectRuntimeBridge();
  return bridge === null ? null : createRuntimeShell(bridge);
}
