import { createStylexTransformCollector } from "@hraness/ui/stylex-build";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = resolve(repositoryRoot, "site");
const escapedSourceRoot = sourceRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const collector = createStylexTransformCollector(repositoryRoot);

// Only the static site's authored modules use this test-time compiler. CLI,
// provider and cloud tests retain their ordinary module-loading boundary.
Bun.plugin({
  name: "hra-site-stylex-test-transform",
  setup(build) {
    build.onLoad({ filter: new RegExp(`^${escapedSourceRoot}/.*\\.[cm]?[jt]sx?$`, "u") }, async ({ path }) => {
      const contents = (await collector.transform(await Bun.file(path).text(), path)).code;
      const extension = extname(path);
      const loader = extension === ".tsx" ? "tsx"
        : extension === ".ts" || extension === ".mts" || extension === ".cts" ? "ts"
          : extension === ".jsx" ? "jsx" : "js";
      return { contents, loader };
    });
  },
});
