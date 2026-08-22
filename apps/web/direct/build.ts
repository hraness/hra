#!/usr/bin/env bun
import { build } from "vite";

import directViteConfig from "./vite.config";
import { verifyBuiltDirectAppearance } from "./verify-built-appearance";

await build({
  ...directViteConfig,
  configFile: false,
});
await verifyBuiltDirectAppearance();
