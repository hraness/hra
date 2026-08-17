import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  authoritiesOverlap,
  inspectProspectivePathAuthority,
  renameWithPathAuthority,
  revalidatePathAuthority,
} from "../installation-path-authority";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

async function root(): Promise<string> {
  const value = await realpath(
    await mkdtemp(join(tmpdir(), "hra-path-authority-")),
  );
  roots.push(value);
  return value;
}

describe("installation path authority", () => {
  test("rejects a symlink in any existing ancestor", async () => {
    const base = await root();
    const actual = join(base, "actual");
    await mkdir(actual);
    await symlink(actual, join(base, "alias"));
    expect(inspectProspectivePathAuthority(
      join(base, "alias", "HRA.app"),
      "candidate",
    )).rejects.toThrow("symbolic-link component");
  });

  test("rejects case-fold and Unicode-normalization sibling aliases", async () => {
    const base = await root();
    await mkdir(join(base, "hra.app"));
    expect(inspectProspectivePathAuthority(
      join(base, "HRA.app"),
      "canonical app",
    )).rejects.toThrow(/alias/u);

    const composed = "Caf\u00e9.app";
    const decomposed = "Cafe\u0301.app";
    await mkdir(join(base, decomposed));
    expect(inspectProspectivePathAuthority(
      join(base, composed),
      "unicode app",
    )).rejects.toThrow(/alias/u);
  });

  test("detects replaced parent identity before mutation", async () => {
    const base = await root();
    const parent = join(base, "Applications");
    await mkdir(parent);
    const authority = await inspectProspectivePathAuthority(
      join(parent, "HRA.app"),
      "canonical app",
    );
    await rename(parent, join(base, "old-Applications"));
    await mkdir(parent);
    expect(revalidatePathAuthority(authority, "canonical app"))
      .rejects.toThrow("changed after validation");
  });

  test("treats folded descendants as overlapping", async () => {
    const base = await root();
    const left = await inspectProspectivePathAuthority(join(base, "Backup"), "left");
    const right = await inspectProspectivePathAuthority(
      join(base, "backup", "state"),
      "right",
    );
    expect(authoritiesOverlap(left, right)).toBe(true);
  });

  test("renames leaves relative to verified directory descriptors", async () => {
    const base = await root();
    const sourcePath = join(base, "source.bundle");
    const destinationPath = join(base, "HRA.app");
    await writeFile(sourcePath, "candidate");
    const source = await inspectProspectivePathAuthority(sourcePath, "source");
    const destination = await inspectProspectivePathAuthority(destinationPath, "destination");
    await renameWithPathAuthority(source, destination);
    expect(await Bun.file(destinationPath).text()).toBe("candidate");
  });

  test("never overwrites a destination created after final revalidation", async () => {
    const base = await root();
    const sourcePath = join(base, "source.bundle");
    const destinationPath = join(base, "HRA.app");
    await writeFile(sourcePath, "candidate");
    const source = await inspectProspectivePathAuthority(sourcePath, "source");
    const destination = await inspectProspectivePathAuthority(
      destinationPath,
      "destination",
    );
    let rejection: unknown;
    try {
      await renameWithPathAuthority(source, destination, {
        beforeRenameForTest: async () => {
          await writeFile(destinationPath, "racer");
        },
      });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message)
      .toContain("Descriptor-relative bundle rename failed");
    expect(await Bun.file(sourcePath).text()).toBe("candidate");
    expect(await Bun.file(destinationPath).text()).toBe("racer");
  });

  test("detects a replaced source leaf and removes the untrusted publication", async () => {
    const base = await root();
    const sourcePath = join(base, "source.bundle");
    const displacedPath = join(base, "displaced.bundle");
    const destinationPath = join(base, "HRA.app");
    await writeFile(sourcePath, "candidate");
    const source = await inspectProspectivePathAuthority(sourcePath, "source");
    const destination = await inspectProspectivePathAuthority(
      destinationPath,
      "destination",
    );
    let rejection: unknown;
    try {
      await renameWithPathAuthority(source, destination, {
        beforeRenameForTest: async () => {
          await rename(sourcePath, displacedPath);
          await writeFile(sourcePath, "racer");
        },
      });
    } catch (error: unknown) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain("leaf identity changed");
    expect(await Bun.file(sourcePath).text()).toBe("racer");
    expect(await Bun.file(displacedPath).text()).toBe("candidate");
    expect(await Bun.file(destinationPath).exists()).toBe(false);
  });

  test("atomically exchanges two verified leaves", async () => {
    const base = await root();
    const sourcePath = join(base, "candidate.bundle");
    const destinationPath = join(base, "HRA.app");
    await writeFile(sourcePath, "candidate");
    await writeFile(destinationPath, "prior");
    await renameWithPathAuthority(
      await inspectProspectivePathAuthority(sourcePath, "source"),
      await inspectProspectivePathAuthority(destinationPath, "destination"),
      { exchange: true },
    );
    expect(await Bun.file(destinationPath).text()).toBe("candidate");
    expect(await Bun.file(sourcePath).text()).toBe("prior");
  });

  test("detects an exchanged target replacement and restores the observed names", async () => {
    const base = await root();
    const sourcePath = join(base, "candidate.bundle");
    const destinationPath = join(base, "HRA.app");
    const displacedPath = join(base, "displaced-prior.bundle");
    await writeFile(sourcePath, "candidate");
    await writeFile(destinationPath, "prior");
    const source = await inspectProspectivePathAuthority(sourcePath, "source");
    const destination = await inspectProspectivePathAuthority(
      destinationPath,
      "destination",
    );
    let rejection: unknown;
    try {
      await renameWithPathAuthority(source, destination, {
        beforeRenameForTest: async () => {
          await rename(destinationPath, displacedPath);
          await writeFile(destinationPath, "racer");
        },
        exchange: true,
      });
    } catch (error: unknown) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain("leaf identity changed");
    expect(await Bun.file(sourcePath).text()).toBe("candidate");
    expect(await Bun.file(destinationPath).text()).toBe("racer");
    expect(await Bun.file(displacedPath).text()).toBe("prior");
  });
});
