// Match production's import order before Babel installs its stack formatter.
// Bun 1.3.14 otherwise fails while Vite 7.3.6 initializes error prototypes.
import "vite";
import { createStylexTransformCollector } from "@hraness/ui/stylex-build";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = resolve(repositoryRoot, "site");
const escapePath = (path: string): string => path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const sharedMenuFiles = ["appearance-menu.tsx", "appearance-menu.stylex.ts"]
  .map((name) => escapePath(resolve(repositoryRoot, "app/src/components", name)));
export const siteStylexTestFilter = new RegExp(`^(?:${escapePath(sourceRoot)}/.*\\.[cm]?[jt]sx?$|${sharedMenuFiles.join("|")})$`, "u");
const collector = createStylexTransformCollector(repositoryRoot);

// The site and its two pure native-menu files share this compiler. Other app,
// CLI, provider and cloud modules retain their ordinary loading boundary.
Bun.plugin({
  name: "oompa-site-stylex-test-transform",
  setup(build) {
    build.onLoad({ filter: siteStylexTestFilter }, async ({ path }) => {
      const contents = (await collector.transform(await Bun.file(path).text(), path)).code;
      const extension = extname(path);
      const loader = extension === ".tsx" ? "tsx"
        : extension === ".ts" || extension === ".mts" || extension === ".cts" ? "ts"
          : extension === ".jsx" ? "jsx" : "js";
      return { contents, loader };
    });
  },
});
