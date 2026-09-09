import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "/etc/apt/sources.list.d/ubuntu.sources";
const MIRRORS = "/etc/apt/apt-mirrors.txt";
const KEYRING = "/usr/share/keyrings/ubuntu-archive-keyring.gpg";
const MAX_TEXT = 256 * 1024;

export interface ChromiumSetupHost {
  platform: string;
  arch: string;
  nodeVersion: string;
  uid: number;
  osRelease: string;
  environment: NodeJS.ProcessEnv;
}

export function assertChromiumSetupHost(host: ChromiumSetupHost): void {
  const field = (name: string, value: string) => new RegExp(`^${name}=(?:${value}|"${value}")$`, "m").test(host.osRelease);
  if (host.platform !== "linux" || host.arch !== "x64" || host.nodeVersion !== "24.18.1" || host.uid === 0
    || !field("ID", "ubuntu") || !field("VERSION_ID", "24\\.04") || !field("VERSION_CODENAME", "noble")) {
    throw new Error("Chromium CI setup requires the original runner user, Node 24.18.1 and Ubuntu 24.04 x64");
  }
  if (host.environment.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE !== undefined || host.environment.APT_CONFIG !== undefined) {
    throw new Error("Chromium CI setup refuses inherited platform or APT configuration overrides");
  }
}

function boundedText(text: string): void {
  if (Buffer.byteLength(text) > MAX_TEXT || text.includes("\r") || text.includes("\0")) {
    throw new Error("Unexpected bounded configuration text");
  }
}

export function assertUbuntuSources(source: string, mirrors: string): void {
  boundedText(source);
  boundedText(mirrors);
  const stanzas = source.split("\n").filter((line) => !line.startsWith("#")).join("\n").replace(/^\n+|\n+$/g, "").split(/\n\s*\n/);
  const official = new Set(["http://azure.archive.ubuntu.com/ubuntu/", "https://archive.ubuntu.com/ubuntu/", "https://security.ubuntu.com/ubuntu/", "http://security.ubuntu.com/ubuntu/"]);
  let usesMirrors = false;
  for (const stanza of stanzas) {
    const fields = new Map<string, string>();
    for (const line of stanza.split("\n")) {
      const match = /^([A-Za-z-]+):\s+(.+)$/.exec(line);
      if (!match || !match[1] || !match[2] || fields.has(match[1])) throw new Error("Unexpected Ubuntu source stanza");
      fields.set(match[1], match[2].trim());
    }
    const uri = fields.get("URIs");
    usesMirrors ||= uri === `mirror+file:${MIRRORS}`;
    if (fields.get("Types") !== "deb" || fields.get("Signed-By") !== KEYRING
      || !uri || (!official.has(uri) && uri !== `mirror+file:${MIRRORS}`)
      || !/^(?:noble(?:-updates|-backports|-security)?)(?: noble(?:-updates|-backports|-security)?)*$/.test(fields.get("Suites") ?? "")
      || !/^(?:main|restricted|universe|multiverse)(?: (?:main|restricted|universe|multiverse))*$/.test(fields.get("Components") ?? "")
      || [...fields.keys()].some((key) => !["Types", "URIs", "Suites", "Components", "Signed-By"].includes(key))) {
      throw new Error("Unexpected stock Ubuntu source layout or signature binding");
    }
  }
  const mirrorLines = mirrors.trim().split("\n");
  if (!usesMirrors || mirrorLines.length !== 3 || new Set(mirrorLines).size !== 3
    || !mirrorLines.every((line, index) => line === [
      "http://azure.archive.ubuntu.com/ubuntu/\tpriority:1",
      "https://archive.ubuntu.com/ubuntu/\tpriority:2",
      "https://security.ubuntu.com/ubuntu/\tpriority:3",
    ][index])) throw new Error("Unexpected stock Ubuntu mirror list");
}

export interface ScopedAptPaths { config: string; sourceParts: string; lists: string }

export function scopedAptConfiguration(paths: ScopedAptPaths): string {
  for (const path of [paths.config, paths.sourceParts, paths.lists]) {
    if (!isAbsolute(path) || !/^\/[A-Za-z0-9_./-]+$/.test(path)) throw new Error("Unsupported scoped APT path");
  }
  return `Dir::Etc::SourceList "${SOURCE}";\nDir::Etc::SourceParts "${paths.sourceParts}";\nDir::State::Lists "${paths.lists}";\n`;
}

export function assertEffectiveAptConfiguration(shell: string, dump: string, paths: ScopedAptPaths): void {
  boundedText(shell);
  boundedText(dump);
  // apt-config shell quotes its values. Admit only these exact assignments; never evaluate them.
  const expected = `SOURCE='${SOURCE}'\nPARTS='${paths.sourceParts}/'\nLISTS='${paths.lists}/'\n`;
  if (shell !== expected && shell !== `${expected}ROOT=''\n`) throw new Error("APT source/list paths or RootDir were overridden");
  for (const line of dump.split("\n")) {
    if (!line) continue;
    const match = /^([^\s";]+) "([^\r\n]*)";$/.exec(line);
    if (!match?.[1] || match[2] === undefined) throw new Error("Unexpected apt-config dump shape");
    const key = match[1].toLowerCase();
    if (key === "binary::apt-get::dir" || key.startsWith("binary::apt-get::dir::")
      || ((key === "rootdir" || key === "binary::apt-get::rootdir") && match[2] !== "")) {
      throw new Error("APT binary or root directory override requires review");
    }
  }
}

export interface SetupCommand { executable: string; args: string[]; capture: boolean }
export type SetupRunner = (command: SetupCommand) => string;

export function installScopedChromium(
  paths: ScopedAptPaths, node: string, cli: string, run: SetupRunner, assertSourcesUnchanged: () => void,
): void {
  if (!isAbsolute(node) || !isAbsolute(cli)) throw new Error("Browser runtime and package CLI must be absolute");
  const sudo = (args: string[], capture = true) => run({ executable: "/usr/bin/sudo", args: ["-n", `APT_CONFIG=${paths.config}`, ...args], capture });
  // This also proves traversal through RUNNER_TEMP without changing any parent permissions.
  run({ executable: "/usr/bin/sudo", args: ["-n", "-u", "_apt", "--", "/usr/bin/test", "-r", paths.config], capture: true });
  const shell = sudo(["/usr/bin/apt-config", "shell", "SOURCE", "Dir::Etc::SourceList/f", "PARTS", "Dir::Etc::SourceParts/d", "LISTS", "Dir::State::Lists/d", "ROOT", "RootDir"]);
  const dump = sudo(["/usr/bin/apt-config", "dump"]);
  assertEffectiveAptConfiguration(shell, dump, paths);
  assertSourcesUnchanged();
  try {
    // Playwright sees uid=0, so its apt children inherit this exact APT_CONFIG without internal sudo.
    sudo([node, cli, "install-deps", "chromium"], false);
  } finally {
    assertSourcesUnchanged();
  }
  // Original user and browser cache; no generated APT_CONFIG is exported to this child.
  run({ executable: node, args: [cli, "install", "chromium"], capture: false });
}

function readRegularText(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > MAX_TEXT) throw new Error("Expected bounded regular setup input");
    const bytes = Buffer.alloc(MAX_TEXT + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size !== before.size || size > MAX_TEXT) throw new Error("Setup input changed while reading");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size));
  } finally { closeSync(fd); }
}

function runSetupCommand(command: SetupCommand): string {
  const result = spawnSync(command.executable, command.args, {
    encoding: "utf8",
    stdio: command.capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    timeout: command.capture ? 30_000 : 20 * 60_000,
    maxBuffer: MAX_TEXT,
  });
  if (result.error || result.status !== 0) {
    // apt-config can contain proxy credentials: never echo its output or an error object.
    throw new Error(command.capture ? "Scoped APT preflight failed" : "Package-pinned Chromium installation failed");
  }
  return command.capture ? result.stdout : "";
}

export function installCiChromium(): void {
  assertChromiumSetupHost({ platform: process.platform, arch: process.arch, nodeVersion: process.versions.node,
    uid: process.getuid?.() ?? 0, osRelease: readRegularText(realpathSync("/etc/os-release")), environment: process.env });
  const source = readRegularText(SOURCE);
  const mirrors = readRegularText(MIRRORS);
  assertUbuntuSources(source, mirrors);
  const runnerTemp = process.env.RUNNER_TEMP;
  if (!runnerTemp || !isAbsolute(runnerTemp)) throw new Error("Expected absolute RUNNER_TEMP");
  const root = mkdtempSync(join(realpathSync(runnerTemp), "hra-chromium-apt-"));
  const paths = { config: join(root, "apt.conf"), sourceParts: join(root, "sourceparts"), lists: join(root, "lists") };
  chmodSync(root, 0o755);
  for (const path of [paths.sourceParts, paths.lists, join(paths.lists, "partial")]) {
    mkdirSync(path, { mode: 0o755 });
    chmodSync(path, 0o755);
  }
  writeFileSync(paths.config, scopedAptConfiguration(paths), { mode: 0o644, flag: "wx" });
  chmodSync(paths.config, 0o644);
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  console.log(`Ubuntu source sha256=${digest(source)} mirrors sha256=${digest(mirrors)}; scoped APT state=${root}`);
  // Retain owned lists/config for runner diagnostics; apt owns its partial directory, never remove global state.
  installScopedChromium(paths, realpathSync(process.execPath), fileURLToPath(new URL("../node_modules/playwright-core/cli.js", import.meta.url)), runSetupCommand, () => {
    if (readRegularText(SOURCE) !== source || readRegularText(MIRRORS) !== mirrors) throw new Error("Stock Ubuntu source bytes changed");
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) installCiChromium();
