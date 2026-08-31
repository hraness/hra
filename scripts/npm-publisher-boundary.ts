const maximumPublisherOutputBytes = 1024 * 1024;
const publisherTimeoutMilliseconds = 5 * 60_000;
const npmRegistry = "https://registry.npmjs.org";
const oidcSuccessMarker = "npm verbose oidc Successfully retrieved and set token";

export type NpmPublisherFailure =
  | "authentication_failed"
  | "authorization_rejected"
  | "github_oidc_fetch_failed"
  | "github_oidc_permission_missing"
  | "network_failed"
  | "oidc_exchange_rejected"
  | "output_limit_exceeded"
  | "post_exchange_failed"
  | "provenance_failed"
  | "publisher_process_failed"
  | "publisher_timed_out"
  | "trusted_exchange_not_proven"
  | "version_conflict";

export type NpmPublisherResult = Readonly<{
  exitCode: number;
  failure: NpmPublisherFailure | null;
  trustedExchangeProven: boolean;
}>;

type PublisherChild = Readonly<{
  exited: Promise<number>;
  kill: (signal?: number | NodeJS.Signals) => void;
  stderr: ReadableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
}>;

type PublisherSpawnOptions = Readonly<{
  env: Record<string, string>;
  stderr: "pipe";
  stdin: "ignore";
  stdout: "pipe";
}>;

export type NpmPublisherSpawn = (
  argv: readonly string[],
  options: PublisherSpawnOptions,
) => PublisherChild;

function validGitHubOidcRequestUrl(value: string | undefined): boolean {
  if (value === undefined || value.length < 1 || value.length > 4_096) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.username === ""
      && url.password === ""
      && url.port === ""
      && url.hash === ""
      && url.hostname !== "actions.githubusercontent.com"
      && url.hostname.endsWith(".actions.githubusercontent.com")
      && !url.pathname.includes("%")
      && url.pathname.includes("/_apis/distributedtask/hubs/")
      && url.pathname.endsWith("/idtoken")
      && url.searchParams.getAll("api-version").length === 1
      && url.searchParams.get("api-version") === "2.0"
      && !url.searchParams.has("audience");
  } catch {
    return false;
  }
}

export function assertNpmPublisherIdentity(
  source: Readonly<Record<string, string | undefined>>,
  expectedTag: string,
  expectedSha: string,
): void {
  if (
    !/^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(expectedTag)
    || !/^[0-9a-f]{40}$/u.test(expectedSha)
    || source.GITHUB_ACTIONS !== "true"
    || source.GITHUB_EVENT_NAME !== "push"
    || source.GITHUB_REF !== `refs/tags/${expectedTag}`
    || source.GITHUB_REF_NAME !== expectedTag
    || source.GITHUB_REF_TYPE !== "tag"
    || source.GITHUB_REPOSITORY !== "hraness/hra"
    || source.GITHUB_REPOSITORY_ID !== "1343008607"
    || source.GITHUB_REPOSITORY_OWNER !== "hraness"
    || source.GITHUB_REPOSITORY_OWNER_ID !== "307125679"
    || source.GITHUB_SHA !== expectedSha
    || source.GITHUB_SERVER_URL !== "https://github.com"
    || source.GITHUB_JOB !== "publish"
    || source.GITHUB_WORKFLOW !== "Release"
    || source.GITHUB_WORKFLOW_REF !== `hraness/hra/.github/workflows/release.yml@refs/tags/${expectedTag}`
    || source.GITHUB_WORKFLOW_SHA !== expectedSha
    || source.RUNNER_ENVIRONMENT !== "github-hosted"
    || source.ACTIONS_ID_TOKEN_REQUEST_TOKEN === undefined
    || source.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length < 1
    || source.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length > 8_192
    || !validGitHubOidcRequestUrl(source.ACTIONS_ID_TOKEN_REQUEST_URL)
  ) {
    throw new Error("npm publishing requires the exact GitHub-hosted release OIDC identity.");
  }
}

function classifyFailure(output: string, trustedExchangeProven: boolean): NpmPublisherFailure {
  if (output.includes("Skipped because incorrect permissions for id-token within GitHub workflow")) {
    return "github_oidc_permission_missing";
  }
  if (output.includes("Failed to fetch id_token from GitHub")) return "github_oidc_fetch_failed";
  if (output.includes("Failed token exchange request with body message")) return "oidc_exchange_rejected";
  if (/(?:^|\n)npm (?:error|verbose) code (?:E401|ENEEDAUTH)(?:\n|$)/u.test(output)) {
    return "authentication_failed";
  }
  if (/(?:^|\n)npm (?:error|verbose) code E403(?:\n|$)/u.test(output)) {
    return "authorization_rejected";
  }
  if (/(?:^|\n)npm (?:error|verbose) code E404(?:\n|$)/u.test(output)) {
    return trustedExchangeProven ? "authorization_rejected" : "oidc_exchange_rejected";
  }
  if (
    /(?:^|\n)npm (?:error|verbose) code (?:ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|ETIMEDOUT)(?:\n|$)/u
      .test(output)
  ) return "network_failed";
  if (
    /(?:^|\n)npm (?:error|verbose) code EPUBLISHCONFLICT(?:\n|$)/u.test(output)
    || output.includes("You cannot publish over the previously published versions")
  ) return "version_conflict";
  if (
    /Provenance generation|Automatic provenance generation|generate provenance|Invalid provenance|Provenance subject|sigstore|fulcio|rekor|transparency log|signing certificate/iu
      .test(output)
  ) return "provenance_failed";
  return trustedExchangeProven ? "post_exchange_failed" : "trusted_exchange_not_proven";
}

async function boundedOutput(
  stream: ReadableStream<Uint8Array>,
  child: PublisherChild,
  aggregate: { bytes: number },
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      aggregate.bytes += item.value.byteLength;
      if (aggregate.bytes > maximumPublisherOutputBytes) {
        child.kill(9);
        throw new Error("npm trusted publication exceeded its output bound.");
      }
      chunks.push(item.value.slice());
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

export function npmPublisherEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const environment = Object.fromEntries([
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "CI",
    "GITHUB_ACTION",
    "GITHUB_ACTIONS",
    "GITHUB_ACTOR_ID",
    "GITHUB_EVENT_NAME",
    "GITHUB_JOB",
    "GITHUB_REF",
    "GITHUB_REF_NAME",
    "GITHUB_REF_TYPE",
    "GITHUB_REPOSITORY",
    "GITHUB_REPOSITORY_ID",
    "GITHUB_REPOSITORY_OWNER",
    "GITHUB_REPOSITORY_OWNER_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_RUN_ID",
    "GITHUB_SERVER_URL",
    "GITHUB_SHA",
    "GITHUB_WORKFLOW",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_WORKFLOW_SHA",
    "HOME",
    "PATH",
    "RUNNER_ENVIRONMENT",
  ].flatMap((name) => {
    const value = source[name];
    return value === undefined ? [] : [[name, value]];
  }));
  return {
    ...environment,
    NO_COLOR: "1",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_LOGS_MAX: "0",
    NPM_CONFIG_REGISTRY: npmRegistry,
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_GLOBALCONFIG: "/dev/null",
    NPM_CONFIG_USERCONFIG: "/dev/null",
  };
}

export function npmPublisherArguments(tarball: string, dryRun: boolean): readonly string[] {
  const argv = [
    "npm",
    "publish",
    tarball,
    "--access",
    "public",
    "--ignore-scripts",
    "--provenance",
    "--json",
    "--loglevel",
    "verbose",
    "--logs-max",
    "0",
  ];
  if (dryRun) argv.push("--dry-run");
  return Object.freeze(argv);
}

const spawnNpmPublisher: NpmPublisherSpawn = (argv, options) => Bun.spawn([...argv], options);

export async function runNpmPublisher(input: Readonly<{
  dryRun: boolean;
  source: Readonly<Record<string, string | undefined>>;
  tarball: string;
}>, dependencies: Readonly<{
  spawn?: NpmPublisherSpawn;
  timeoutMilliseconds?: number;
}> = {}): Promise<NpmPublisherResult> {
  const timeoutMilliseconds = dependencies.timeoutMilliseconds ?? publisherTimeoutMilliseconds;
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1) {
    throw new Error("npm trusted publication received an invalid timeout.");
  }
  let child: PublisherChild;
  try {
    child = (dependencies.spawn ?? spawnNpmPublisher)(
      npmPublisherArguments(input.tarball, input.dryRun),
      {
        env: npmPublisherEnvironment(input.source),
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
      },
    );
  } catch {
    return Object.freeze({
      exitCode: 1,
      failure: "publisher_process_failed",
      trustedExchangeProven: false,
    });
  }
  const timeoutState = { didExpire: false };
  const timer = setTimeout(() => {
    timeoutState.didExpire = true;
    child.kill(9);
  }, Math.min(timeoutMilliseconds, publisherTimeoutMilliseconds));
  const aggregate = { bytes: 0 };
  const [exit, stdoutResult, stderrResult] = await Promise.allSettled([
    child.exited,
    boundedOutput(child.stdout, child, aggregate),
    boundedOutput(child.stderr, child, aggregate),
  ]).finally(() => clearTimeout(timer));
  if (timeoutState.didExpire) {
    return Object.freeze({
      exitCode: exit.status === "fulfilled" ? exit.value : 1,
      failure: "publisher_timed_out",
      trustedExchangeProven: false,
    });
  }
  if (stdoutResult.status === "rejected" || stderrResult.status === "rejected") {
    return Object.freeze({
      exitCode: exit.status === "fulfilled" ? exit.value : 1,
      failure: "output_limit_exceeded",
      trustedExchangeProven: false,
    });
  }
  if (exit.status === "rejected") {
    return Object.freeze({
      exitCode: 1,
      failure: "publisher_process_failed",
      trustedExchangeProven: false,
    });
  }
  const exitCode = exit.value;
  const stdout = stdoutResult.value;
  const stderr = stderrResult.value;
  const output = `${stdout}\n${stderr}`;
  const trustedExchangeProven = output.includes(oidcSuccessMarker);
  if (exitCode === 0 && trustedExchangeProven) {
    return Object.freeze({ exitCode, failure: null, trustedExchangeProven });
  }
  return Object.freeze({
    exitCode,
    failure: classifyFailure(output, trustedExchangeProven),
    trustedExchangeProven,
  });
}
