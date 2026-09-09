import { createStylexTransformCollector } from "@hraness/ui/stylex-build";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = resolve(repositoryRoot, "app/src");
const escapedSourceRoot = sourceRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const collector = createStylexTransformCollector(repositoryRoot);

// The test process uses the same public compiler as the production graph.
// Domain, provider, CLI, and package tests remain outside this load hook.
Bun.plugin({
  name: "hra-app-stylex-test-transform",
  setup(build) {
    build.onLoad(
      { filter: new RegExp(`^${escapedSourceRoot}/.*\\.[cm]?[jt]sx?$`, "u") },
      async ({ path }) => {
        const contents = (await collector.transform(await Bun.file(path).text(), path)).code;
        const extension = extname(path);
        const loader = extension === ".tsx" ? "tsx"
          : extension === ".ts" || extension === ".mts" || extension === ".cts" ? "ts"
            : extension === ".jsx" ? "jsx" : "js";
        return { contents, loader };
      },
    );
  },
});
