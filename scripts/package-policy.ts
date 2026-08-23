import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export async function assertProductionPackageOnly(root: string): Promise<void> {
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      const packagePath = relative(root, child).replaceAll("\\", "/");
      if (
        /(?:^|\/)scripts(?:\/|$)/u.test(packagePath)
        || /(?:^|\/)convex(?:\/|$)/u.test(packagePath)
        || /(?:^|\/)kb(?:\/|$)/u.test(packagePath)
        || /(?:^|\/)site(?:\/|$)/u.test(packagePath)
        || /(?:^|\/)\.github(?:\/|$)/u.test(packagePath)
        || /(?:^|\/)docs\/live-acceptance(?:\/|\.|$)/u.test(packagePath)
        || /(?:^|\/)live-acceptance[^/]*\.ts$/u.test(packagePath)
        || packagePath === "src/cloud/inviteAuthority.ts"
      ) {
        throw new Error("The install artifact contains repository-only source.");
      }
      if (entry.isDirectory()) await visit(child);
      else if (
        entry.isFile()
        && (
          entry.name === "AGENTS.md"
          || entry.name.endsWith(".test.ts")
          || entry.name === "testAssertions.ts"
        )
      ) {
        throw new Error("The install artifact contains development-only source.");
      }
    }
  };
  await visit(root);
}
