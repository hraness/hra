import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

import {
  provisionHraConvexDeployKey,
  readConvexPersonalAccessToken,
  safeProvisioningErrorCode,
  type ConvexManagementFetch,
} from "./create-convex-deploy-key";

const temporaryDirectories: string[] = [];
const accessToken = "convex-personal-access-token-fixture";
const createdSecret =
  "prod:benevolent-akita-439|generated-deploy-key-fixture";

const project = {
  createTime: 1,
  devDeploymentName: null,
  id: 2_680_173,
  name: "oprte",
  prodDeploymentName: "benevolent-akita-439",
  slug: "oprte",
  teamId: 513_923,
  teamSlug: "cclrte",
} as const;

const deployment = {
  class: "default",
  createTime: 1,
  deploymentType: "prod",
  deploymentUrl: "https://benevolent-akita-439.convex.cloud",
  id: 4_677_913,
  isDefault: true,
  kind: "cloud",
  name: "benevolent-akita-439",
  projectId: 2_680_173,
  reference: "production",
  region: "aws-us-east-1",
} as const;

const oldKey = {
  allowedActions: ["deployment:deploy", "deployment:env:view"],
  creationTime: 1,
  expiresAt: null,
  id: 2_635_749,
  lastUsedTime: 2,
  name: "vercel-oprte-production-2026-08-10",
} as const;

const hraKey = {
  allowedActions: ["deployment:deploy"],
  creationTime: 3,
  expiresAt: null,
  id: 2_700_001,
  lastUsedTime: null,
  name: "vercel-hra-production-2026-08-17",
} as const;

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function fixtureFiles(options?: Readonly<{
  authMode?: number;
  destinationMode?: number;
  destinationValue?: string;
}>): Readonly<{ authFile: string; secretFile: string }> {
  const directory = realpathSync.native(
    mkdtempSync(join(tmpdir(), "hra-convex-key-")),
  );
  temporaryDirectories.push(directory);
  const authFile = join(directory, "convex-config.json");
  const secretFile = join(directory, "deploy-key");
  writeFileSync(authFile, JSON.stringify({ accessToken }), {
    mode: options?.authMode ?? 0o600,
  });
  writeFileSync(secretFile, options?.destinationValue ?? "", {
    mode: options?.destinationMode ?? 0o600,
  });
  chmodSync(authFile, options?.authMode ?? 0o600);
  chmodSync(secretFile, options?.destinationMode ?? 0o600);
  return {
    authFile: realpathSync.native(authFile),
    secretFile: realpathSync.native(secretFile),
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

async function expectProvisioningFailure(
  operation: Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  let failure: unknown;
  try {
    await operation;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) {
    throw new Error("expected-provisioning-failure");
  }
  expect(failure.message).toBe(expectedCode);
}

function successfulFetch(
  calls: Array<Readonly<{ init: RequestInit | undefined; url: string }>>,
  afterKeys: readonly unknown[] = [oldKey, hraKey],
): ConvexManagementFetch {
  let keyListCalls = 0;
  return (input, init) => {
    const url = requestUrl(input);
    calls.push({ init, url });
    if (url.endsWith("/projects/2680173")) return Promise.resolve(json(project));
    if (url.endsWith("/deployments/benevolent-akita-439")) {
      return Promise.resolve(json(deployment));
    }
    if (url.endsWith("/list_deploy_keys")) {
      keyListCalls += 1;
      return Promise.resolve(json(keyListCalls === 1 ? [oldKey] : afterKeys));
    }
    if (url.endsWith("/create_deploy_key")) {
      return Promise.resolve(json({ deployKey: createdSecret }));
    }
    return Promise.resolve(json({ code: "not-found" }, 404));
  };
}

describe("Convex provider credential custody", () => {
  test("reads only a canonical owner-held mode-0600 Convex auth file", () => {
    const files = fixtureFiles();
    expect(readConvexPersonalAccessToken(files.authFile)).toBe(accessToken);
    expect(() => readConvexPersonalAccessToken(
      fixtureFiles({ authMode: 0o644 }).authFile,
    )).toThrow("provider-file-custody-invalid");
  });

  test("rejects a relaxed, nonempty, or aliased secret destination", async () => {
    const relaxed = fixtureFiles({ destinationMode: 0o644 });
    await expectProvisioningFailure(provisionHraConvexDeployKey({
      ...relaxed,
      fetch: successfulFetch([]),
    }), "provider-file-custody-invalid");

    const nonempty = fixtureFiles({ destinationValue: "occupied" });
    await expectProvisioningFailure(provisionHraConvexDeployKey({
      ...nonempty,
      fetch: successfulFetch([]),
    }), "provider-file-custody-invalid");

    const aliased = fixtureFiles();
    const aliasPath = join(dirname(aliased.secretFile), "deploy-key-alias");
    symlinkSync(aliased.secretFile, aliasPath);
    await expectProvisioningFailure(provisionHraConvexDeployKey({
      authFile: aliased.authFile,
      fetch: successfulFetch([]),
      secretFile: aliasPath,
    }), "provider-file-custody-invalid");

    const relaxedParent = fixtureFiles();
    chmodSync(dirname(relaxedParent.secretFile), 0o755);
    await expectProvisioningFailure(provisionHraConvexDeployKey({
      ...relaxedParent,
      fetch: successfulFetch([]),
    }), "provider-secret-parent-custody-invalid");
  });

  test("never formats foreign errors, access tokens, or generated keys", () => {
    expect(safeProvisioningErrorCode(new Error("provider-key-readback-mismatch")))
      .toBe("provider-key-readback-mismatch");
    expect(safeProvisioningErrorCode(new Error("provider-http-403")))
      .toBe("provider-http-403");
    expect(safeProvisioningErrorCode(new Error(accessToken)))
      .toBe("provider-operation-failed");
    expect(safeProvisioningErrorCode(new Error(createdSecret)))
      .toBe("provider-operation-failed");
  });
});

describe("least-privilege Convex deploy-key provisioning", () => {
  test("binds immutable provider IDs and writes the secret only to the supplied file", async () => {
    const files = fixtureFiles();
    const calls: Array<Readonly<{
      init: RequestInit | undefined;
      url: string;
    }>> = [];
    const result = await provisionHraConvexDeployKey({
      ...files,
      fetch: successfulFetch(calls),
    });

    expect(readFileSync(files.secretFile, "utf8")).toBe(createdSecret);
    expect(statSync(files.secretFile).mode & 0o777).toBe(0o600);
    expect(result).toEqual({
      action: "create-deploy-key",
      deployment: {
        id: 4_677_913,
        name: "benevolent-akita-439",
        projectId: 2_680_173,
      },
      key: hraKey,
      project: {
        id: 2_680_173,
        slug: "oprte",
        teamId: 513_923,
        teamSlug: "cclrte",
      },
      secretFile: {
        bytes: Buffer.byteLength(createdSecret),
        mode: "0600",
        path: files.secretFile,
      },
    });

    const createCall = calls.find(({ url }) => url.endsWith("/create_deploy_key"));
    expect(createCall).toBeDefined();
    expect(createCall?.init?.method).toBe("POST");
    const createBody = createCall?.init?.body;
    expect(typeof createBody).toBe("string");
    if (typeof createBody !== "string") {
      throw new Error("expected-string-request-body");
    }
    expect(JSON.parse(createBody)).toEqual({
      allowedActions: ["deployment:deploy"],
      name: "vercel-hra-production-2026-08-17",
    });
    expect(calls.map(({ url }) => url)).toEqual([
      "https://api.convex.dev/v1/projects/2680173",
      "https://api.convex.dev/v1/deployments/benevolent-akita-439",
      "https://api.convex.dev/v1/deployments/benevolent-akita-439/list_deploy_keys",
      "https://api.convex.dev/v1/deployments/benevolent-akita-439/create_deploy_key",
      "https://api.convex.dev/v1/deployments/benevolent-akita-439/list_deploy_keys",
      "https://api.convex.dev/v1/projects/2680173",
      "https://api.convex.dev/v1/deployments/benevolent-akita-439",
    ]);

    const stableDigest = createHash("sha256").update(createdSecret).digest("hex");
    const observable = JSON.stringify({
      bodies: calls.map(({ init }) => init?.body ?? null),
      result,
      urls: calls.map(({ url }) => url),
    });
    expect(observable).not.toContain(createdSecret);
    expect(observable).not.toContain(stableDigest);
    expect(observable).not.toContain(accessToken);
    expect(calls.every(({ init }) =>
      (init?.headers as Record<string, string> | undefined)?.Authorization
        === `Bearer ${accessToken}`)).toBe(true);
  });

  test("refuses identity drift before creating a key", async () => {
    const files = fixtureFiles();
    const calls: string[] = [];
    const providerFetch: ConvexManagementFetch = (input) => {
      const url = requestUrl(input);
      calls.push(url);
      if (url.endsWith("/projects/2680173")) {
        return Promise.resolve(json({ ...project, id: 2_680_174 }));
      }
      return Promise.resolve(json({ code: "unexpected" }, 500));
    };
    await expectProvisioningFailure(
      provisionHraConvexDeployKey({ ...files, fetch: providerFetch }),
      "provider-project-identity-mismatch",
    );
    expect(calls).toHaveLength(1);
    expect(readFileSync(files.secretFile, "utf8")).toBe("");
  });

  test("refuses an existing name and a broader permission readback", async () => {
    const existingFiles = fixtureFiles();
    const existingCalls: Array<Readonly<{
      init: RequestInit | undefined;
      url: string;
    }>> = [];
    const existingFetch = successfulFetch(existingCalls);
    let listCalls = 0;
    const withExistingName: ConvexManagementFetch = (input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/list_deploy_keys")) {
        listCalls += 1;
        existingCalls.push({ init, url });
        return Promise.resolve(json([oldKey, hraKey]));
      }
      return existingFetch(input, init);
    };
    await expectProvisioningFailure(provisionHraConvexDeployKey({
      ...existingFiles,
      fetch: withExistingName,
    }), "provider-key-name-already-exists");
    expect(listCalls).toBe(1);
    expect(existingCalls.some(({ url }) => url.endsWith("/create_deploy_key")))
      .toBe(false);

    const broadFiles = fixtureFiles();
    const broadKey = {
      ...hraKey,
      allowedActions: ["deployment:deploy", "deployment:data:write"],
    };
    await expectProvisioningFailure(provisionHraConvexDeployKey({
      ...broadFiles,
      fetch: successfulFetch([], [oldKey, broadKey]),
    }), "provider-key-readback-mismatch");
    expect(readFileSync(broadFiles.secretFile, "utf8")).toBe("");
  });

  test("requires complete fresh metadata and preserves the entire prior key list", async () => {
    const missingMetadata = fixtureFiles();
    const withoutExpiry = {
      allowedActions: hraKey.allowedActions,
      creationTime: hraKey.creationTime,
      id: hraKey.id,
      lastUsedTime: hraKey.lastUsedTime,
      name: hraKey.name,
    };
    await expectProvisioningFailure(provisionHraConvexDeployKey({
      ...missingMetadata,
      fetch: successfulFetch([], [oldKey, withoutExpiry]),
    }), "provider-key-metadata-invalid");
    expect(readFileSync(missingMetadata.secretFile, "utf8")).toBe("");

    const used = fixtureFiles();
    await expectProvisioningFailure(provisionHraConvexDeployKey({
      ...used,
      fetch: successfulFetch([], [oldKey, { ...hraKey, lastUsedTime: 4 }]),
    }), "provider-key-readback-mismatch");
    expect(readFileSync(used.secretFile, "utf8")).toBe("");

    const changedPrior = fixtureFiles();
    await expectProvisioningFailure(provisionHraConvexDeployKey({
      ...changedPrior,
      fetch: successfulFetch([], [
        { ...oldKey, lastUsedTime: 5 },
        hraKey,
      ]),
    }), "provider-key-readback-mismatch");
    expect(readFileSync(changedPrior.secretFile, "utf8")).toBe("");
  });

  test("rechecks project and deployment identity before committing the secret", async () => {
    const files = fixtureFiles();
    const base = successfulFetch([]);
    let projectCalls = 0;
    const providerFetch: ConvexManagementFetch = (input, init) => {
      if (requestUrl(input).endsWith("/projects/2680173")) {
        projectCalls += 1;
        return Promise.resolve(json(
          projectCalls === 1 ? project : { ...project, slug: "hra" },
        ));
      }
      return base(input, init);
    };
    await expectProvisioningFailure(
      provisionHraConvexDeployKey({ ...files, fetch: providerFetch }),
      "provider-project-identity-mismatch",
    );
    expect(readFileSync(files.secretFile, "utf8")).toBe("");
  });

  test("rejects a secret for any other deployment", async () => {
    const files = fixtureFiles();
    const base = successfulFetch([]);
    const providerFetch: ConvexManagementFetch = (input, init) =>
      requestUrl(input).endsWith("/create_deploy_key")
        ? Promise.resolve(json({ deployKey: "prod:other-deployment-123|secret" }))
        : base(input, init);
    await expectProvisioningFailure(
      provisionHraConvexDeployKey({ ...files, fetch: providerFetch }),
      "provider-created-key-invalid",
    );
    expect(readFileSync(files.secretFile, "utf8")).toBe("");
  });
});
