const forwardedEnvironmentNames = Object.freeze([
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TMPDIR",
] as const);

type SourceEnvironment = Readonly<Record<string, string | undefined>>;

export function githubPublisherEnvironment(source: SourceEnvironment): Readonly<Record<string, string>> {
  const token = source.GH_TOKEN;
  if (token === undefined || token.length === 0) {
    throw new Error("GitHub Release publication requires one GitHub token.");
  }
  if (source.PATH === undefined || source.PATH.length === 0) {
    throw new Error("GitHub Release publication requires one executable search path.");
  }
  const environment: Record<string, string> = {
    GH_PROMPT_DISABLED: "1",
    GH_TOKEN: token,
    NO_COLOR: "1",
  };
  for (const name of forwardedEnvironmentNames) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return Object.freeze(environment);
}
