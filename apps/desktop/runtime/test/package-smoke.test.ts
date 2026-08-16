import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packageSmokeRoot } from "../src/package-smoke";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hra-package-smoke-")));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("packaged gateway smoke root", () => {
  test("accepts only an owned private canonical root", () => {
    const root = temporaryRoot();
    expect(packageSmokeRoot({ HRA_PACKAGE_SMOKE_ROOT: root })).toBe(root);
    expect(packageSmokeRoot({})).toBeNull();

    chmodSync(root, 0o755);
    expect(() => packageSmokeRoot({ HRA_PACKAGE_SMOKE_ROOT: root }))
      .toThrow("owned private directory");
  });

  test("rejects a symlink, traversal, and the wrong prefix", () => {
    const root = temporaryRoot();
    const link = `${root}-link`;
    roots.push(link);
    symlinkSync(root, link);
    expect(() => packageSmokeRoot({ HRA_PACKAGE_SMOKE_ROOT: link }))
      .toThrow("owned private directory");
    expect(() => packageSmokeRoot({
      HRA_PACKAGE_SMOKE_ROOT: join(root, "..", "elsewhere"),
    })).toThrow("invalid");
    expect(() => packageSmokeRoot({
      HRA_PACKAGE_SMOKE_ROOT: join(tmpdir(), "unrelated-smoke-root"),
    })).toThrow("invalid");
  });
});
