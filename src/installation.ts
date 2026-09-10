import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveCloudDeploymentEnvironment, type CloudDeploymentEnvironment } from "./domain/cloud-deployment-environment";

import {
  personalProviderPaths,
  resolveStatePaths,
  type PersonalProviderPaths,
  type StatePaths,
} from "./storage/paths";
import { GenerationalSecretCustody } from "./storage/secret-custody";

type HraInstallationCommon = Readonly<{
  cloudEnvironment: CloudDeploymentEnvironment;
  codexEnvironment(codexHome: string): Promise<Readonly<Record<string, string | undefined>> | undefined>;
  credentialStorePreflight: Readonly<{
    readonly cliAuth: "file";
    readonly cwd: string;
    readonly mcpOauth: "file";
  }>;
  documentsDirectory: string;
  paths: StatePaths;
  personalProviderHomes: PersonalProviderPaths;
  createSecretCustody(): GenerationalSecretCustody;
  prepareCodexHome(codexHome: string): Promise<void>;
}>;

export type HraInstallation = HraInstallationCommon & (
  | Readonly<{
      desktopSwitching: true;
      expectedHomeDirectory: null;
      kind: "production";
    }>
  | Readonly<{
      desktopSwitching: false;
      expectedHomeDirectory: string;
      kind: "live_acceptance";
    }>
);

const noOpPrepareCodexHome = (): Promise<void> => Promise.resolve();
const defaultCodexEnvironment = (): Promise<undefined> => Promise.resolve(undefined);

export function createProductionInstallation(): HraInstallation {
  const paths = resolveStatePaths();
  const cloud = resolveCloudDeploymentEnvironment(process.env);
  return {
    // Capturing a conflict must not prevent help, local diagnosis, or stop.
    // Authority-starting consumers require agreement before their first effect.
    cloudEnvironment: cloud.environment,
    codexEnvironment: defaultCodexEnvironment,
    credentialStorePreflight: {
      cliAuth: "file",
      cwd: resolve(process.cwd()),
      mcpOauth: "file",
    },
    createSecretCustody: () => new GenerationalSecretCustody(paths),
    desktopSwitching: true,
    documentsDirectory: join(homedir(), "Documents"),
    expectedHomeDirectory: null,
    kind: "production",
    paths,
    personalProviderHomes: personalProviderPaths(),
    prepareCodexHome: noOpPrepareCodexHome,
  };
}

export function assertInstallationHome(installation: HraInstallation): void {
  if (
    installation.expectedHomeDirectory !== null
    && process.env.HOME !== installation.expectedHomeDirectory
  ) {
    throw new Error("Live acceptance must preserve the invoking HOME exactly.");
  }
}
