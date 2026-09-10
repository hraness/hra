import { describe, expect, test } from "bun:test";
import {
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { AuthorityFetcher } from "./bounded-authority-fetch";
import { canonicalDigest } from "./release-evidence";
import {
  appSourceProofErrorCodes,
  appSourceProofEvidenceSchema,
  executeAppSourceProof,
  executeRetainedAppSourceProofVerification,
  oompaAppAlias,
  oompaAppBuildSettingsDigest,
  oompaAppProjectId,
  oompaAppRepositoryId,
  oompaAppTeamId,
  parseAppSourceProofArguments,
  parseRetainedAppSourceProofArguments,
  readRetainedAppSourceProof,
  type AppSourceProofEvidence,
  type AppSourceState,
} from "./verify-app-source";

const deploymentId = "dpl_AppSourceProof123456789012345";
const sourceCommit = "6".repeat(40);
const releaseVersion = "0.6.1";
const deploymentUrl = "hra-app-source-proof-hraness.vercel.app";
const nonce = "123e4567-e89b-42d3-a456-426614174000";
const accessToken = "test-vercel-access-value";
const evidencePath = "/protected/release/hra-app-source-proof.json";
const deploymentSettings = {
  buildCommand: "cd .. && bun install --frozen-lockfile --ignore-scripts && bun run build:app",
  commandForIgnoringBuildStep: 'test "$VERCEL_ENV" != "production"',
  devCommand: null,
  framework: null,
  installCommand: "true",
  outputDirectory: "dist",
};
const buildSettings = {
  ...deploymentSettings,
  rootDirectory: "app",
  sourceFilesOutsideRootDirectory: true,
};

const arguments_ = [
  "--deployment-id",
  deploymentId,
  "--evidence-path",
  evidencePath,
  "--source-commit",
  sourceCommit,
  "--release-version",
  releaseVersion,
  "--vercel-auth-fd",
  "3",
] as const;

const project = {
  ...buildSettings,
  accountId: oompaAppTeamId,
  commandForIgnoringBuildStep: null,
  id: oompaAppProjectId,
  link: {
    org: "hraness",
    productionBranch: "main",
    repo: "oompa",
    repoId: oompaAppRepositoryId,
    type: "github",
  },
  name: "oompa-app",
  skewProtectionMaxAge: 0,
};

const deployment = {
  gitSource: {
    ref: "main",
    repoId: oompaAppRepositoryId,
    sha: sourceCommit,
    type: "github",
  },
  id: deploymentId,
  projectSettings: deploymentSettings,
  projectId: oompaAppProjectId,
  readyState: "READY",
  source: "git",
  target: "production",
  url: deploymentUrl,
};
const deploymentSnapshot = {
  prebuilt: false,
  projectId: oompaAppProjectId,
  projectSettings: buildSettings,
  readyState: "READY",
  source: "git",
  target: "production",
  uid: deploymentId,
  url: deploymentUrl,
};
const deploymentList = {
  deployments: [deploymentSnapshot],
  pagination: { count: 1, next: null, prev: null },
};

const alias = {
  alias: oompaAppAlias,
  deployment: { id: deploymentId, url: deploymentUrl },
  deploymentId,
  projectId: oompaAppProjectId,
  uid: "alias-app-oompa-sh",
  updatedAt: 1_788_706_800_000,
};

const projectDomain = {
  apexName: "oompa.app",
  customEnvironmentId: null,
  gitBranch: null,
  name: oompaAppAlias,
  projectId: oompaAppProjectId,
  redirect: null,
  redirectStatusCode: null,
  verified: true,
};
const domainConfig = {
  acceptedChallenges: ["http-01"],
  configuredBy: "CNAME",
  misconfigured: false,
  recommendedCNAME: [{ rank: 1, value: "cname.vercel-dns.com" }],
  recommendedIPv4: [],
};
const rollingRelease = { rollingRelease: null };
const bulkRedirects = {
  pagination: { numPages: 0, page: 1, per_page: 1 },
  redirects: [],
};
const firewall = {
  changes: [],
  firewallEnabled: true,
  id: "firewall-config-production",
  ips: [],
  ownerId: oompaAppTeamId,
  projectKey: oompaAppProjectId,
  rules: [],
  rulesets: [],
  updatedAt: "2026-09-06T14:00:00.000Z",
  version: 7,
};
const routeVersions = { versions: [] };

const marker = {
  generation: 1,
  product: "Oompa App",
  repository: { id: oompaAppRepositoryId, path: "hraness/oompa" },
  schemaVersion: 1,
  source: { commit: sourceCommit },
  version: releaseVersion,
};

const exactSourceState = (
  overrides: Partial<AppSourceState> = {},
): AppSourceState => ({
  commit: sourceCommit,
  exactOrigin: true,
  indexTransparent: true,
  remoteMainCommit: sourceCommit,
  rootExact: true,
  trackedAndUntrackedClean: true,
  ...overrides,
});

const redigestProof = (
  proof: AppSourceProofEvidence,
  changes: Readonly<Record<string, unknown>>,
): unknown => {
  const unsigned: Record<string, unknown> = { ...proof, ...changes };
  delete unsigned.selfDigest;
  return { ...unsigned, selfDigest: canonicalDigest(unsigned) };
};

const providerUrl = (path: string): string => {
  const url = new URL(path, "https://api.vercel.com");
  url.searchParams.set("teamId", oompaAppTeamId);
  return url.href;
};

const markerUrl = `https://${oompaAppAlias}/.well-known/oompa-app.json?proof=${nonce}`;
const deploymentListUrl = (until?: number): string => providerUrl(
  `/v7/deployments?projectId=${oompaAppProjectId}`
    + "&target=production&state=READY&branch=main"
    + `&sha=${sourceCommit}&limit=20${until === undefined ? "" : `&until=${until}`}`,
);

type PlannedResponse = Readonly<{
  cacheControl?: string;
  contentType?: string;
  document: unknown;
  redirected?: boolean;
  responseUrl?: string;
  status?: number;
  url: string;
}>;

type RecordedRequest = Readonly<{ init: RequestInit | undefined; url: string }>;

const jsonResponse = (planned: PlannedResponse): Response => {
  const body = typeof planned.document === "string"
    ? planned.document
    : JSON.stringify(planned.document);
  const response = new Response(body, {
    headers: {
      "cache-control": planned.cacheControl ?? "no-store",
      "content-type": planned.contentType ?? "application/json; charset=utf-8",
    },
    status: planned.status ?? 200,
  });
  Object.defineProperties(response, {
    redirected: { value: planned.redirected ?? false },
    url: { value: planned.responseUrl ?? planned.url },
  });
  return response;
};

type ProviderSampleOverrides = Partial<Readonly<{
  aliasDocument: unknown;
  bulkRedirectDocument: unknown;
  deploymentDocument: unknown;
  deploymentListPages: readonly Readonly<{ document: unknown; until?: number }>[];
  domainConfigDocument: unknown;
  exactRoutes: Readonly<{ document: unknown; versionId: string }>;
  firewallDocument: unknown;
  projectDocument: unknown;
  projectDomainDocument: unknown;
  rollingReleaseDocument: unknown;
  routeVersionsDocument: unknown;
}>>;

const providerSample = (
  overrides: ProviderSampleOverrides = {},
): readonly PlannedResponse[] => {
  const documents = {
    aliasDocument: alias,
    bulkRedirectDocument: bulkRedirects,
    deploymentDocument: deployment,
    domainConfigDocument: domainConfig,
    firewallDocument: firewall,
    projectDocument: project,
    projectDomainDocument: projectDomain,
    rollingReleaseDocument: rollingRelease,
    routeVersionsDocument: routeVersions,
    ...overrides,
  };
  const deploymentListPages = overrides.deploymentListPages
    ?? [{ document: deploymentList }];
  return [
    {
      document: documents.projectDocument,
      url: providerUrl(`/v9/projects/${oompaAppProjectId}`),
    },
    {
      document: documents.projectDomainDocument,
      url: providerUrl(`/v9/projects/${oompaAppProjectId}/domains/${oompaAppAlias}`),
    },
    {
      document: documents.domainConfigDocument,
      url: providerUrl(
        `/v6/domains/${oompaAppAlias}/config?projectIdOrName=${oompaAppProjectId}`,
      ),
    },
    {
      document: documents.rollingReleaseDocument,
      url: providerUrl(`/v1/projects/${oompaAppProjectId}/rolling-release`),
    },
    {
      document: documents.bulkRedirectDocument,
      url: providerUrl(
        `/v1/bulk-redirects?projectId=${oompaAppProjectId}&page=1&per_page=1`,
      ),
    },
    {
      document: documents.firewallDocument,
      url: providerUrl(
        `/v1/security/firewall/config/active?projectId=${oompaAppProjectId}`,
      ),
    },
    {
      document: documents.routeVersionsDocument,
      url: providerUrl(`/v1/projects/${oompaAppProjectId}/routes/versions`),
    },
    ...(overrides.exactRoutes === undefined ? [] : [{
      document: overrides.exactRoutes.document,
      url: providerUrl(
        `/v1/projects/${oompaAppProjectId}/routes?versionId=${overrides.exactRoutes.versionId}`,
      ),
    }]),
    ...deploymentListPages.map((page) => ({
      document: page.document,
      url: deploymentListUrl(page.until),
    })),
    {
      document: documents.deploymentDocument,
      url: providerUrl(`/v13/deployments/${deploymentId}?withGitRepoInfo=true`),
    },
    {
      document: documents.aliasDocument,
      url: providerUrl(`/v4/aliases/${oompaAppAlias}`),
    },
  ];
};

const completePlan = (
  markerResponse: PlannedResponse = { document: marker, url: markerUrl },
  after: readonly PlannedResponse[] = providerSample(),
): readonly PlannedResponse[] => [
  ...providerSample(),
  markerResponse,
  ...after,
];

const plannedFetcher = (
  plan: readonly PlannedResponse[],
  requests: RecordedRequest[],
): AuthorityFetcher => async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  requests.push({ init, url });
  const expected = plan[requests.length - 1];
  if (expected === undefined || expected.url !== url) {
    throw new Error("unexpected app proof request");
  }
  return jsonResponse(expected);
};

const output = (): { readonly lines: string[]; readonly writer: { write(value: string): void } } => {
  const lines: string[] = [];
  return { lines, writer: { write: (value) => { lines.push(value); } } };
};

const execute = async (
  plan: readonly PlannedResponse[],
  sourceState: () => AppSourceState = () => exactSourceState(),
): Promise<Readonly<{
  code: number;
  requests: readonly RecordedRequest[];
  stderr: string;
  stdout: string;
  evidence: readonly unknown[];
}>> => {
  const stdout = output();
  const stderr = output();
  const requests: RecordedRequest[] = [];
  const evidence: unknown[] = [];
  const times = [
    new Date("2026-09-06T14:00:00.000Z"),
    new Date("2026-09-06T14:00:01.000Z"),
  ];
  const code = await executeAppSourceProof({
    accessToken,
    arguments: arguments_,
    clock: () => times.shift() ?? new Date("invalid"),
    evidenceWriter: (path, value) => {
      expect(path).toBe(evidencePath);
      evidence.push(value);
    },
    fetcher: plannedFetcher(plan, requests),
    monotonicClock: (() => {
      const times = [1_000, 2_000];
      return () => times.shift() ?? Number.NaN;
    })(),
    nonce: () => nonce,
    runtimeVersion: "1.3.14",
    sourceState,
    stderr: stderr.writer,
    stdout: stdout.writer,
  });
  return {
    code,
    requests,
    stderr: stderr.lines.join(""),
    stdout: stdout.lines.join(""),
    evidence,
  };
};

describe("Oompa browser app source proof", () => {
  test("sandwiches the strict public marker between complete authenticated provider samples", async () => {
    const result = await execute(completePlan());
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.requests.map((request) => request.url)).toEqual([
      providerUrl(`/v9/projects/${oompaAppProjectId}`),
      providerUrl(`/v9/projects/${oompaAppProjectId}/domains/${oompaAppAlias}`),
      providerUrl(`/v6/domains/${oompaAppAlias}/config?projectIdOrName=${oompaAppProjectId}`),
      providerUrl(`/v1/projects/${oompaAppProjectId}/rolling-release`),
      providerUrl(`/v1/bulk-redirects?projectId=${oompaAppProjectId}&page=1&per_page=1`),
      providerUrl(`/v1/security/firewall/config/active?projectId=${oompaAppProjectId}`),
      providerUrl(`/v1/projects/${oompaAppProjectId}/routes/versions`),
      deploymentListUrl(),
      providerUrl(`/v13/deployments/${deploymentId}?withGitRepoInfo=true`),
      providerUrl(`/v4/aliases/${oompaAppAlias}`),
      markerUrl,
      providerUrl(`/v9/projects/${oompaAppProjectId}`),
      providerUrl(`/v9/projects/${oompaAppProjectId}/domains/${oompaAppAlias}`),
      providerUrl(`/v6/domains/${oompaAppAlias}/config?projectIdOrName=${oompaAppProjectId}`),
      providerUrl(`/v1/projects/${oompaAppProjectId}/rolling-release`),
      providerUrl(`/v1/bulk-redirects?projectId=${oompaAppProjectId}&page=1&per_page=1`),
      providerUrl(`/v1/security/firewall/config/active?projectId=${oompaAppProjectId}`),
      providerUrl(`/v1/projects/${oompaAppProjectId}/routes/versions`),
      deploymentListUrl(),
      providerUrl(`/v13/deployments/${deploymentId}?withGitRepoInfo=true`),
      providerUrl(`/v4/aliases/${oompaAppAlias}`),
    ]);
    for (const [index, request] of result.requests.entries()) {
      const headers = new Headers(request.init?.headers);
      expect(request.init?.method).toBe("GET");
      expect(request.init?.redirect).toBe("error");
      expect(request.init?.cache).toBe("no-store");
      expect(headers.get("cache-control")).toBe("no-cache");
      expect(headers.get("authorization"))
        .toBe(index === 10 ? null : `Bearer ${accessToken}`);
    }

    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThan(4_096);
    expect(result.stdout).not.toContain(accessToken);
    expect(JSON.parse(result.stdout)).toEqual({
      alias: oompaAppAlias,
      aliasUid: alias.uid,
      aliasUpdatedAt: alias.updatedAt,
      branch: "main",
      bulkRedirectVersionId: null,
      cacheControl: "no-store",
      completedAt: "2026-09-06T14:00:01.000Z",
      deploymentBuildSettingsDigest: oompaAppBuildSettingsDigest,
      deploymentId,
      deploymentUrl,
      domainConfiguredBy: "CNAME",
      firewallConfigId: firewall.id,
      firewallConfigVersion: firewall.version,
      firewallEnabled: true,
      kind: "hra-app-source-proof",
      marker,
      observationBoundary: "sequential-readback-without-provider-lock",
      projectBuildSettingsDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      projectId: oompaAppProjectId,
      projectRouteVersionId: null,
      readyState: "READY",
      releaseVersion,
      repositoryId: oompaAppRepositoryId,
      rollingReleaseState: null,
      schemaVersion: 2,
      selfDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      skewProtectionBoundaryAt: null,
      skewProtectionMaxAge: 0,
      sourceCommit,
      sourceRemoteMainCommit: sourceCommit,
      startedAt: "2026-09-06T14:00:00.000Z",
      target: "production",
      teamId: oompaAppTeamId,
      verifierIndexTransparent: true,
      verifierSourceCommit: sourceCommit,
      verifierTrackedAndUntrackedClean: true,
    });
    expect(result.evidence).toEqual([JSON.parse(result.stdout)]);
  });

  test("requires the fixed project account and main Git link", async () => {
    for (const changedProject of [
      { ...project, accountId: "team_wrong" },
      { ...project, link: { ...project.link, productionBranch: "preview" } },
      { ...project, link: { ...project.link, repoId: 1 } },
    ]) {
      const result = await execute(providerSample({ projectDocument: changedProject }));
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        '{"code":"provider_readback_invalid","schemaVersion":1,"status":"refused"}\n',
      );
    }
  });

  test("requires exact clean current-main source authority before any provider read", async () => {
    for (const sourceState of [
      () => exactSourceState({ trackedAndUntrackedClean: false }),
      () => exactSourceState({ commit: "7".repeat(40) }),
      () => exactSourceState({ remoteMainCommit: "7".repeat(40) }),
      () => exactSourceState({ exactOrigin: false }),
      () => exactSourceState({ indexTransparent: false }),
      () => exactSourceState({ rootExact: false }),
    ]) {
      const result = await execute([], sourceState);
      expect(result.code).toBe(1);
      expect(result.requests).toEqual([]);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        '{"code":"verifier_source_invalid","schemaVersion":1,"status":"refused"}\n',
      );
    }
  });

  test("refuses when protected main advances during provider observation", async () => {
    let reads = 0;
    const result = await execute(completePlan(), () => {
      reads += 1;
      return reads === 1
        ? exactSourceState()
        : exactSourceState({ remoteMainCommit: "7".repeat(40) });
    });
    expect(result.code).toBe(1);
    expect(result.evidence).toEqual([]);
    expect(result.stderr).toContain('"code":"verifier_source_invalid"');
  });

  test("publishes optional operator evidence as one protected no-replace file", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "oompa-app-source-evidence-"));
    const path = join(root, "proof.json");
    const proofArguments = [...arguments_];
    proofArguments[proofArguments.indexOf("--evidence-path") + 1] = path;
    const stdout = output();
    const stderr = output();
    const requests: RecordedRequest[] = [];
    try {
      const code = await executeAppSourceProof({
        accessToken,
        arguments: proofArguments,
        clock: (() => {
          const times = [
            new Date("2026-09-06T14:00:00.000Z"),
            new Date("2026-09-06T14:00:01.000Z"),
          ];
          return () => times.shift() ?? new Date("invalid");
        })(),
        fetcher: plannedFetcher(completePlan(), requests),
        nonce: () => nonce,
        runtimeVersion: "1.3.14",
        sourceState: () => exactSourceState(),
        stderr: stderr.writer,
        stdout: stdout.writer,
      });
      expect(code).toBe(0);
      expect(stderr.lines).toEqual([]);
      const stats = lstatSync(path);
      expect(stats.isFile()).toBe(true);
      expect(stats.isSymbolicLink()).toBe(false);
      expect(stats.nlink).toBe(1);
      expect(stats.mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(path, "utf8")))
        .toEqual(JSON.parse(stdout.lines.join("")));

      const replay = await executeAppSourceProof({
        accessToken,
        arguments: proofArguments,
        clock: (() => {
          const times = [
            new Date("2026-09-06T14:00:00.000Z"),
            new Date("2026-09-06T14:00:01.000Z"),
          ];
          return () => times.shift() ?? new Date("invalid");
        })(),
        fetcher: plannedFetcher(completePlan(), [],),
        nonce: () => nonce,
        runtimeVersion: "1.3.14",
        sourceState: () => exactSourceState(),
        stderr: stderr.writer,
        stdout: stdout.writer,
      });
      expect(replay).toBe(1);
      expect(stderr.lines.join("")).toContain('"code":"proof_output_invalid"');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("strictly revalidates retained proof digest, bindings, and requested source", async () => {
    const generated = await execute(completePlan());
    const proof = generated.evidence[0] as AppSourceProofEvidence;
    const root = mkdtempSync(join(realpathSync(tmpdir()), "oompa-app-source-retained-"));
    const path = join(root, "proof.json");
    try {
      writeFileSync(path, `${JSON.stringify(proof)}\n`, { mode: 0o600 });
      expect(readRetainedAppSourceProof(path, {
        evidencePath: path,
        releaseVersion,
        sourceCommit,
      })).toEqual(proof);

      const stdout = output();
      const stderr = output();
      expect(executeRetainedAppSourceProofVerification({
        arguments: [
          "--evidence-path",
          path,
          "--release-version",
          releaseVersion,
          "--source-commit",
          sourceCommit,
        ],
        runtimeVersion: "1.3.14",
        sourceState: () => exactSourceState(),
        stderr: stderr.writer,
        stdout: stdout.writer,
      })).toBe(0);
      expect(stderr.lines).toEqual([]);
      expect(JSON.parse(stdout.lines.join(""))).toEqual({
        evidenceDigest: proof.selfDigest,
        kind: "hra-app-source-proof-verification",
        releaseVersion,
        schemaVersion: 1,
        sourceCommit,
        status: "verified",
      });

      expect(() => readRetainedAppSourceProof(path, {
        evidencePath: path,
        releaseVersion: "1.0.0",
        sourceCommit,
      })).toThrow("retained_proof_invalid");
      writeFileSync(path, `${JSON.stringify({ ...proof, releaseVersion: "1.0.0" })}\n`, {
        mode: 0o600,
      });
      expect(() => readRetainedAppSourceProof(path, {
        evidencePath: path,
        releaseVersion: "1.0.0",
        sourceCommit,
      })).toThrow("retained_proof_invalid");

      expect(appSourceProofEvidenceSchema.safeParse({
        ...proof,
        marker: {
          ...proof.marker,
          source: { commit: "7".repeat(40) },
        },
      }).success).toBe(false);
      expect(appSourceProofEvidenceSchema.safeParse({
        ...proof,
        aliasUpdatedAt: proof.aliasUpdatedAt + 1,
      }).success).toBe(false);
      expect(appSourceProofEvidenceSchema.safeParse(redigestProof(proof, {
        deploymentBuildSettingsDigest: "a".repeat(64),
      })).success).toBe(false);
      expect(appSourceProofEvidenceSchema.safeParse(redigestProof(proof, {
        projectBuildSettingsDigest: "b".repeat(64),
      })).success).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("strictly recovers an interrupted no-replace proof publication", async () => {
    const generated = await execute(completePlan());
    const proof = generated.evidence[0] as AppSourceProofEvidence;
    const root = mkdtempSync(join(realpathSync(tmpdir()), "oompa-app-source-interrupted-"));
    const path = join(root, "proof.json");
    const temporary = join(root, ".proof.json.0123456789abcdef0123456789abcdef.tmp");
    try {
      writeFileSync(temporary, `${JSON.stringify(proof)}\n`, { mode: 0o600 });
      linkSync(temporary, path);
      expect(lstatSync(path).nlink).toBe(2);

      const stdout = output();
      const stderr = output();
      expect(executeRetainedAppSourceProofVerification({
        arguments: [
          "--evidence-path",
          path,
          "--release-version",
          releaseVersion,
          "--source-commit",
          sourceCommit,
        ],
        runtimeVersion: "1.3.14",
        sourceState: () => exactSourceState(),
        stderr: stderr.writer,
        stdout: stdout.writer,
      })).toBe(0);
      expect(stderr.lines).toEqual([]);
      expect(lstatSync(path).nlink).toBe(1);
      expect(() => lstatSync(temporary)).toThrow();
      expect(JSON.parse(stdout.lines.join(""))).toMatchObject({
        evidenceDigest: proof.selfDigest,
        status: "verified",
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("parses only exact retained-proof verification inputs", () => {
    const retained = [
      "--evidence-path",
      evidencePath,
      "--release-version",
      releaseVersion,
      "--source-commit",
      sourceCommit,
    ] as const;
    expect(parseRetainedAppSourceProofArguments(retained)).toEqual({
      evidencePath,
      releaseVersion,
      sourceCommit,
    });
    expect(() => parseRetainedAppSourceProofArguments(retained.slice(0, -2)))
      .toThrow("usage_invalid");
  });

  test("rechecks current-main source after reading retained evidence", async () => {
    const generated = await execute(completePlan());
    const proof = generated.evidence[0] as AppSourceProofEvidence;
    let reads = 0;
    const stdout = output();
    const stderr = output();
    expect(executeRetainedAppSourceProofVerification({
      arguments: [
        "--evidence-path",
        evidencePath,
        "--release-version",
        releaseVersion,
        "--source-commit",
        sourceCommit,
      ],
      proofReader: () => proof,
      runtimeVersion: "1.3.14",
      sourceState: () => {
        reads += 1;
        return reads === 1
          ? exactSourceState()
          : exactSourceState({ remoteMainCommit: "7".repeat(40) });
      },
      stderr: stderr.writer,
      stdout: stdout.writer,
    })).toBe(1);
    expect(reads).toBe(2);
    expect(stdout.lines).toEqual([]);
    expect(stderr.lines.join("")).toContain('"code":"verifier_source_invalid"');
  });

  test("binds the current project and effective deployment build settings", async () => {
    for (const firstSample of [
      providerSample({
        projectDocument: { ...project, rootDirectory: "other" },
      }),
      providerSample({
        projectDocument: { ...project, sourceFilesOutsideRootDirectory: false },
      }),
      providerSample({
        projectDocument: {
          ...project,
          commandForIgnoringBuildStep: "exit 0",
        },
      }),
      providerSample({
        deploymentDocument: {
          ...deployment,
          projectSettings: {
            ...deploymentSettings,
            buildCommand: "printf attacker > dist/index.html",
          },
        },
      }),
      providerSample({
        deploymentDocument: {
          ...deployment,
          projectSettings: { ...deploymentSettings, framework: "vite" },
        },
      }),
      providerSample({
        deploymentDocument: {
          ...deployment,
          projectSettings: { ...deploymentSettings, installCommand: "bun install" },
        },
      }),
      providerSample({
        deploymentListPages: [{
          document: {
            ...deploymentList,
            deployments: [{
              ...deploymentSnapshot,
              projectSettings: { ...buildSettings, rootDirectory: "other" },
            }],
          },
        }],
      }),
      providerSample({
        deploymentListPages: [{
          document: {
            ...deploymentList,
            deployments: [{
              ...deploymentSnapshot,
              projectSettings: {
                ...buildSettings,
                sourceFilesOutsideRootDirectory: false,
              },
            }],
          },
        }],
      }),
    ]) {
      const result = await execute(firstSample);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain('"code":"provider_readback_invalid"');
    }
  });

  test("detects a change between the two accepted dashboard ignore states", async () => {
    const changed = await execute(completePlan(
      { document: marker, url: markerUrl },
      providerSample({
        projectDocument: {
          ...project,
          commandForIgnoringBuildStep: deploymentSettings.commandForIgnoringBuildStep,
        },
      }),
    ));
    expect(changed.code).toBe(1);
    expect(changed.evidence).toEqual([]);
    expect(changed.stderr).toContain('"code":"authority_changed_during_observation"');
  });

  test("walks a bounded deployment-snapshot cursor to the exact deployment", async () => {
    const otherDeployment = {
      ...deploymentSnapshot,
      uid: "dpl_OtherSourceProof123456789012345",
      url: "oompa-app-other-source-proof-hraness.vercel.app",
    };
    const sample = (): readonly PlannedResponse[] => providerSample({
      deploymentListPages: [{
        document: {
          deployments: [otherDeployment],
          pagination: { count: 1, next: 123, prev: null },
        },
      }, {
        document: {
          deployments: [deploymentSnapshot],
          pagination: { count: 1, next: null, prev: 456 },
        },
        until: 123,
      }],
    });
    const result = await execute([
      ...sample(),
      { document: marker, url: markerUrl },
      ...sample(),
    ]);
    expect(result.code).toBe(0);
    expect(result.requests.map((request) => request.url))
      .toContain(deploymentListUrl(123));

    const cyclic = await execute(providerSample({
      deploymentListPages: [{
        document: {
          deployments: [otherDeployment],
          pagination: { count: 1, next: 123, prev: null },
        },
      }, {
        document: {
          deployments: [otherDeployment],
          pagination: { count: 1, next: 123, prev: null },
        },
        until: 123,
      }],
    }));
    expect(cyclic.code).toBe(1);
    expect(cyclic.stderr).toContain('"code":"provider_readback_invalid"');
  });

  test("requires the direct verified project domain and non-proxy DNS", async () => {
    for (const hostileSample of [
      providerSample({
        projectDomainDocument: { ...projectDomain, name: "app.oompa.dev", apexName: "oompa.dev" },
      }),
      providerSample({
        projectDomainDocument: { ...projectDomain, verified: false },
      }),
      providerSample({
        projectDomainDocument: {
          ...projectDomain,
          redirect: "other.invalid",
          redirectStatusCode: 307,
        },
      }),
      providerSample({
        projectDomainDocument: {
          ...projectDomain,
          customEnvironmentId: "env_preview",
        },
      }),
      providerSample({
        domainConfigDocument: { ...domainConfig, configuredBy: "http" },
      }),
      providerSample({
        domainConfigDocument: { ...domainConfig, misconfigured: true },
      }),
    ]) {
      const result = await execute(hostileSample);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain('"code":"provider_readback_invalid"');
    }
  });

  test("requires a READY production Git deployment and the exact alias tuple", async () => {
    for (const firstSample of [
      providerSample({ aliasDocument: { ...alias, alias: "app.oompa.dev" } }),
      providerSample({ deploymentDocument: { ...deployment, readyState: "BUILDING" } }),
      providerSample({ deploymentDocument: { ...deployment, target: null } }),
      providerSample({ deploymentDocument: { ...deployment, source: "cli" } }),
      providerSample({ deploymentDocument: { ...deployment, prebuilt: true } }),
      providerSample({ aliasDocument: {
        ...alias,
        deployment: { ...alias.deployment, url: "other-app-hraness.vercel.app" },
      } }),
      providerSample({ aliasDocument: { ...alias, redirect: "attacker.invalid" } }),
      providerSample({ aliasDocument: { ...alias, redirectStatusCode: 301 } }),
      providerSample({ aliasDocument: {
        ...alias,
        microfrontends: {
          applications: [{ fallbackHost: "other.vercel.app", projectId: "prj_other" }],
          defaultApp: { projectId: oompaAppProjectId },
        },
      } }),
    ]) {
      const result = await execute(firstSample);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain('"code":"provider_readback_invalid"');
    }
  });

  test("refuses active rolling releases and live project routing rules", async () => {
    const activeRollingRelease = await execute(providerSample({
      rollingReleaseDocument: { rollingRelease: { state: "ACTIVE" } },
    }));
    expect(activeRollingRelease.code).toBe(1);
    expect(activeRollingRelease.stdout).toBe("");
    expect(activeRollingRelease.stderr).toContain('"code":"provider_readback_invalid"');

    const liveVersion = {
      id: "route-version-production",
      isLive: true,
      ruleCount: 1,
    };
    const routed = await execute(providerSample({
      exactRoutes: {
        document: {
          routes: [{ id: "route-1", route: { dest: "https://attacker.invalid", src: "/(.*)" } }],
          version: liveVersion,
        },
        versionId: liveVersion.id,
      },
      routeVersionsDocument: { versions: [liveVersion] },
    }));
    expect(routed.code).toBe(1);
    expect(routed.stdout).toBe("");
    expect(routed.stderr).toContain('"code":"provider_readback_invalid"');
  });

  test("refuses every project state that can skew traffic to an older deployment", async () => {
    for (const projectDocument of [
      { ...project, skewProtectionMaxAge: 86_400_000 },
      { ...project, skewProtectionBoundaryAt: 1_788_706_700_000 },
    ]) {
      const result = await execute(providerSample({ projectDocument }));
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain('"code":"provider_readback_invalid"');
    }
  });

  test("refuses live bulk redirects and active WAF redirect rules", async () => {
    const bulkRedirect = await execute(providerSample({
      bulkRedirectDocument: {
        pagination: { numPages: 1, page: 1, per_page: 1 },
        redirects: [{ destination: "https://attacker.invalid", source: "/" }],
        version: {
          id: "bulk-redirect-production",
          isLive: true,
          redirectCount: 1,
        },
      },
    }));
    expect(bulkRedirect.code).toBe(1);
    expect(bulkRedirect.stdout).toBe("");
    expect(bulkRedirect.stderr).toContain('"code":"provider_readback_invalid"');

    const inconsistentEmptyRedirectPage = await execute(providerSample({
      bulkRedirectDocument: {
        pagination: { numPages: 1, page: 1, per_page: 1 },
        redirects: [],
      },
    }));
    expect(inconsistentEmptyRedirectPage.code).toBe(1);
    expect(inconsistentEmptyRedirectPage.stderr)
      .toContain('"code":"provider_readback_invalid"');

    for (const firewallDocument of [
      { ...firewall, ownerId: "team_wrong" },
      { ...firewall, projectKey: "prj_wrong" },
    ]) {
      const result = await execute(providerSample({ firewallDocument }));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('"code":"provider_readback_invalid"');
    }

    for (const firewallDocument of [
      {
        ...firewall,
        rules: [{
          action: { mitigate: { action: "redirect" } },
          active: true,
          valid: true,
        }],
      },
      {
        ...firewall,
        rulesets: [{
          action: { mitigate: { action: "redirect" } },
          active: true,
        }],
      },
      {
        ...firewall,
        rulesets: { managed: { action: "redirect" } },
      },
      {
        ...firewall,
        rules: [{
          action: { mitigate: { action: "unknown_future_action" } },
          active: true,
          valid: true,
        }],
      },
    ]) {
      const result = await execute(providerSample({ firewallDocument }));
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain('"code":"provider_readback_invalid"');
    }
  });

  test("accepts an exact live project-route version only when it has no rules", async () => {
    const liveVersion = {
      id: "route-version-empty-production",
      isLive: true,
      ruleCount: 0,
    };
    const sampleWithEmptyLiveVersion = (): readonly PlannedResponse[] =>
      providerSample({
        exactRoutes: {
          document: { routes: [], version: liveVersion },
          versionId: liveVersion.id,
        },
        routeVersionsDocument: { versions: [liveVersion] },
      });
    const result = await execute([
      ...sampleWithEmptyLiveVersion(),
      { document: marker, url: markerUrl },
      ...sampleWithEmptyLiveVersion(),
    ]);
    expect(result.code).toBe(0);
  });

  test("refuses a marker with extra data, mismatched identity, or missing no-store", async () => {
    for (const markerResponse of [
      { document: { ...marker, unexpected: "private-provider-data" }, url: markerUrl },
      { document: { ...marker, version: "0.5.0" }, url: markerUrl },
      { cacheControl: "public, max-age=60", document: marker, url: markerUrl },
      { contentType: "text/html", document: "<html>fallback</html>", url: markerUrl },
      { contentType: "application/jsonp", document: marker, url: markerUrl },
    ]) {
      const result = await execute(completePlan(markerResponse));
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        '{"code":"marker_readback_invalid","schemaVersion":1,"status":"refused"}\n',
      );
      expect(result.stderr).not.toContain("private-provider-data");
    }
  });

  test("accepts no-store as a standalone case-insensitive cache directive", async () => {
    const result = await execute(completePlan({
      cacheControl: "private, NO-STORE",
      document: marker,
      url: markerUrl,
    }));
    expect(result.code).toBe(0);
  });

  test("refuses alias authority that changes around the public marker", async () => {
    const changedUrl = "hra-app-source-proof-next-hraness.vercel.app";
    const result = await execute(completePlan(
      { document: marker, url: markerUrl },
      providerSample({
        aliasDocument: {
          ...alias,
          deployment: { id: deploymentId, url: changedUrl },
        },
        deploymentDocument: { ...deployment, url: changedUrl },
        deploymentListPages: [{
          document: {
            ...deploymentList,
            deployments: [{ ...deploymentSnapshot, url: changedUrl }],
          },
        }],
      }),
    ));
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      '{"code":"authority_changed_during_observation","schemaVersion":1,"status":"refused"}\n',
    );
  });

  test("detects an alias updatedAt change between the sampled states", async () => {
    const result = await execute(completePlan(
      { document: marker, url: markerUrl },
      providerSample({
        aliasDocument: {
          ...alias,
          updatedAt: alias.updatedAt + 1,
        },
      }),
    ));
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      '{"code":"authority_changed_during_observation","schemaVersion":1,"status":"refused"}\n',
    );
  });

  test("refuses redirected or wrong-origin readbacks without exposing bodies or credentials", async () => {
    for (const planned of [{
        document: { secret: "provider-private-document" },
        responseUrl: "https://attacker.invalid/project",
        url: providerUrl(`/v9/projects/${oompaAppProjectId}`),
      }, {
        document: { secret: "provider-private-document" },
        redirected: true,
        url: providerUrl(`/v9/projects/${oompaAppProjectId}`),
      }]) {
      const hostile = await execute([planned]);
      expect(hostile.code).toBe(1);
      expect(hostile.stdout).toBe("");
      expect(hostile.stderr).toBe(
        '{"code":"provider_readback_invalid","schemaVersion":1,"status":"refused"}\n',
      );
      expect(hostile.stderr).not.toContain("provider-private-document");
      expect(hostile.stderr).not.toContain(accessToken);
    }
  });

  test("bounds provider and public marker response bodies", async () => {
    const oversizedProvider = await execute([{
      document: "x".repeat(128 * 1024 + 1),
      url: providerUrl(`/v9/projects/${oompaAppProjectId}`),
    }]);
    expect(oversizedProvider.code).toBe(1);
    expect(oversizedProvider.stdout).toBe("");
    expect(oversizedProvider.stderr).toContain('"code":"provider_readback_invalid"');

    const oversizedMarker = await execute(completePlan({
      document: "x".repeat(16 * 1024 + 1),
      url: markerUrl,
    }));
    expect(oversizedMarker.code).toBe(1);
    expect(oversizedMarker.stdout).toBe("");
    expect(oversizedMarker.stderr).toContain('"code":"marker_readback_invalid"');
  });

  test("parses only one complete set of exact proof inputs", () => {
    expect(parseAppSourceProofArguments(arguments_)).toEqual({
      deploymentId,
      evidencePath,
      releaseVersion,
      sourceCommit,
      vercelAuthFd: 3,
    });
    for (const invalid of [
      arguments_.slice(0, -2),
      [...arguments_, "--source-commit", sourceCommit],
      [...arguments_.slice(0, -1), "03"],
      [...arguments_.slice(0, -1), "256"],
      [...arguments_.slice(0, 5), "A".repeat(40), ...arguments_.slice(6)],
      [...arguments_.slice(0, 7), "01.0.0", ...arguments_.slice(8)],
      [...arguments_.slice(0, 7), "1.0.0-beta.1", ...arguments_.slice(8)],
      [...arguments_, "--unknown", "value"],
    ]) expect(() => parseAppSourceProofArguments(invalid)).toThrow("usage_invalid");
    expect(parseAppSourceProofArguments([
      ...arguments_.slice(0, 7),
      "1.0.0",
      ...arguments_.slice(8),
    ]).releaseVersion).toBe("1.0.0");
  });

  test("keeps the refusal vocabulary closed and rejects invalid explicit credentials", async () => {
    expect(new Set(appSourceProofErrorCodes).size).toBe(appSourceProofErrorCodes.length);
    const stdout = output();
    const stderr = output();
    const code = await executeAppSourceProof({
      accessToken: "contains a space",
      arguments: arguments_,
      fetcher: async () => { throw new Error("must not fetch"); },
      nonce: () => nonce,
      runtimeVersion: "1.3.14",
      sourceState: () => exactSourceState(),
      stderr: stderr.writer,
      stdout: stdout.writer,
    });
    expect(code).toBe(1);
    expect(stdout.lines).toEqual([]);
    expect(stderr.lines.join("")).toBe(
      '{"code":"provider_credentials_refused","schemaVersion":1,"status":"refused"}\n',
    );
  });

});
