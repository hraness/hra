import { dirname, isAbsolute, join, parse, relative } from "node:path";
import { accountProfileIdSchema } from "../../../contracts/runtime";

export interface AccountProfileLayout {
  readonly stateRoot: string;
  readonly accountsRoot: string;
  readonly profileRoot: string;
  readonly codexHome: string;
  readonly runtimeDirectory: string;
}

export class UnsafeAccountProfilePathError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`Unsafe account-profile path (${reason}): ${path}`);
    this.name = "UnsafeAccountProfilePathError";
    this.path = path;
  }
}

export function accountProfileLayout(
  controlPlanePath: string,
  accountProfileId: string,
): AccountProfileLayout {
  if (!isAbsolute(controlPlanePath)) {
    throw new Error("Control-plane database path must be absolute");
  }
  const validatedId = accountProfileIdSchema.parse(accountProfileId);
  const stateRoot = dirname(controlPlanePath);
  if (stateRoot === parse(stateRoot).root) {
    throw new UnsafeAccountProfilePathError(stateRoot, "filesystem root cannot be an app-state root");
  }
  const accountsRoot = join(stateRoot, "codex", "accounts");
  const profileRoot = join(accountsRoot, validatedId);
  const codexHome = join(profileRoot, "home");
  const runtimeDirectory = join(profileRoot, "runtime");

  assertDirectChild(accountsRoot, profileRoot);
  assertDirectChild(profileRoot, codexHome);
  assertDirectChild(profileRoot, runtimeDirectory);

  return { stateRoot, accountsRoot, profileRoot, codexHome, runtimeDirectory };
}

function assertDirectChild(parent: string, child: string): void {
  const suffix = relative(parent, child);
  if (suffix.length === 0 || suffix.startsWith("..") || suffix.includes("/")) {
    throw new UnsafeAccountProfilePathError(child, "not a direct child of its owned root");
  }
}
