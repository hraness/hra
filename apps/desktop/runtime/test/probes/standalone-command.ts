import { childEnvironment, type RuntimePaths } from "../../src/runtime-paths";
import { CodexAppServerClient } from "./app-server-client";

/**
 * Deliberately independent black-box probe for an operation that HRA does
 * not expose through its production pinned protocol.
 */
export async function runWorkspaceWriteTouchProbe(
  paths: RuntimePaths,
  cwd: string,
  marker: string,
): Promise<unknown> {
  const client = CodexAppServerClient.launch({
    command: [paths.codexBinary, "app-server", "--stdio"],
    cwd: paths.codexHome,
    env: childEnvironment(paths),
  });
  try {
    await client.request("initialize", {
      clientInfo: {
        name: "hra-probe",
        title: "HRA protocol probe",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    }, 30_000);
    client.notify("initialized");
    return await client.request("command/exec", {
      command: ["/usr/bin/touch", marker],
      cwd,
      timeoutMs: 5_000,
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    }, 30_000);
  } finally {
    await client.close();
  }
}
