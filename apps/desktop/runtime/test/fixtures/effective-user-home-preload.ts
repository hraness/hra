import { mock } from "bun:test";
import { realpathSync } from "node:fs";
import * as nodeOs from "node:os";

const configuredEffectiveHome =
  process.env.HRA_GATEWAY_TEST_EFFECTIVE_HOME;
if (configuredEffectiveHome === undefined) {
  throw new Error("Gateway test effective-user home is required.");
}
const effectiveHome = realpathSync(configuredEffectiveHome);
const originalUserInfo = nodeOs.userInfo;

await mock.module("node:os", () => ({
  ...nodeOs,
  homedir: () => effectiveHome,
  userInfo: (...args: Parameters<typeof nodeOs.userInfo>) => ({
    ...originalUserInfo(...args),
    homedir: effectiveHome,
  }),
}));
