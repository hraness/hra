import { mock } from "bun:test";

import * as computerUseProvisioning from
  "../../src/codex/computer-use-provisioning";

const verifiedTestProvisioning = Object.freeze({
  serverName: "node_repl" as const,
  requiredToolName: "js" as const,
  threadConfig: Object.freeze({
    "mcp_servers.node_repl": Object.freeze({
      command: "/usr/bin/true",
      args: Object.freeze([]),
      startup_timeout_sec: 1,
    }),
  }),
  developerInstructions:
    "Gateway integration fixture: node_repl + @oai/sky is externally provisioned.",
});

// This preload is injected only into the gateway subprocess created by the
// integration test. Production has no environment switch or fallback around
// `provisionOfficialComputerUse`, so a real launch remains fail closed.
await mock.module("../../src/codex/computer-use-provisioning", () => ({
  ...computerUseProvisioning,
  provisionOfficialComputerUse: () => verifiedTestProvisioning,
}));
