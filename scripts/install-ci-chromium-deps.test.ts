import { expect, test } from "bun:test";
import {
  assertAptTemporaryRoot, assertChromiumSetupHost, assertEffectiveAptConfiguration, assertUbuntuSources,
  installScopedChromium, scopedAptConfiguration, type ChromiumSetupHost, type SetupCommand,
} from "./install-ci-chromium-deps.ts";

const host: ChromiumSetupHost = {
  platform: "linux", arch: "x64", nodeVersion: "24.18.1", uid: 1001,
  osRelease: 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n', environment: {},
};
const paths = { config: "/runner/hra-apt/apt.conf", sourceParts: "/runner/hra-apt/sourceparts", lists: "/runner/hra-apt/lists" };
const shell = `SOURCE='/etc/apt/sources.list.d/ubuntu.sources'\nPARTS='${paths.sourceParts}/'\nLISTS='${paths.lists}/'\n`;
const dump = 'Dir "/";\nDir::Etc "etc/apt";\nBinary::apt "";\nBinary::apt::APT::Keep-Downloaded-Packages "0";\n';
const source = [
  "# Existing runner image source; its exact bytes remain in place.",
  "Types: deb", "URIs: mirror+file:/etc/apt/apt-mirrors.txt", "Suites: noble noble-updates noble-backports",
  "Components: main restricted universe multiverse", "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg", "",
  "Types: deb", "URIs: http://security.ubuntu.com/ubuntu/", "Suites: noble-security",
  "Components: main restricted universe multiverse", "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg", "",
].join("\n");
const mirrors = "http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n";

test("APT scratch requires a protected public temporary root without changing private parent permissions", () => {
  expect(() => assertAptTemporaryRoot(0, 0o41777, true)).not.toThrow();
  for (const [uid, mode, directory] of [
    [1001, 0o41777, true], [0, 0o40700, true], [0, 0o40750, true],
    [0, 0o41770, true], [0, 0o41776, true], [0, 0o40777, true],
    [0, 0o41777, false], [0, 0o43777, true],
  ] as const) expect(() => assertAptTemporaryRoot(uid, mode, directory)).toThrow();
});

test("setup admits only the supported native runner and refuses inherited retargeting", () => {
  expect(() => assertChromiumSetupHost(host)).not.toThrow();
  for (const changed of [
    { platform: "darwin" }, { arch: "arm64" }, { nodeVersion: "24.18.2" }, { uid: 0 },
    { osRelease: host.osRelease.replace("ubuntu", "debian") },
    { osRelease: host.osRelease.replace("24.04", "22.04") },
    { osRelease: host.osRelease.replace("noble", "jammy") },
    { environment: { PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: "ubuntu24.04-x64" } },
    { environment: { PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: "" } },
    { environment: { APT_CONFIG: "/another/apt.conf" } },
  ]) expect(() => assertChromiumSetupHost({ ...host, ...changed })).toThrow();
});

test("stock source, signature binding and mirror priorities are preserved without synthetic repositories", () => {
  expect(() => assertUbuntuSources(source, mirrors)).not.toThrow();
  for (const changed of [
    "", source.replace("ubuntu-archive-keyring.gpg", "other.gpg"),
    source.replace("mirror+file:/etc/apt/apt-mirrors.txt", "https://dl.google.com/linux/chrome/deb/"),
    source.replace("noble-updates", "jammy-updates"), source.replace("Types: deb", "Types: deb-src"),
    source.replace("Components: main", "Trusted: yes\nComponents: main"),
    source.replace("Components: main", "Check-Valid-Until: no\nComponents: main"),
    source.replace("Components: main", "Components: main\nComponents: main"),
    source.replace("Types: deb", " Types: deb"), `${source}\r`, "x".repeat(256 * 1024 + 1),
  ]) expect(() => assertUbuntuSources(changed, mirrors)).toThrow();
  for (const changed of ["", mirrors.replace("priority:1", "priority:2"), `${mirrors}https://other.example/\tpriority:4\n`]) {
    expect(() => assertUbuntuSources(source, changed)).toThrow();
  }
});

test("scoped config contains exactly the three path settings and cannot inject APT options", () => {
  expect(scopedAptConfiguration(paths)).toBe(`Dir::Etc::SourceList "/etc/apt/sources.list.d/ubuntu.sources";\nDir::Etc::SourceParts "${paths.sourceParts}";\nDir::State::Lists "${paths.lists}";\n`);
  for (const path of ["relative", '/tmp/a"; Trusted "yes', "/tmp/a\nb", "/tmp/a b"]) {
    expect(() => scopedAptConfiguration({ ...paths, sourceParts: path })).toThrow();
  }
});

test("effective config refuses late root and binary overrides, malformed or oversized output", () => {
  expect(() => assertEffectiveAptConfiguration(shell, dump, paths)).not.toThrow();
  expect(() => assertEffectiveAptConfiguration(`${shell}ROOT=''\n`, `${dump}RootDir "";\n`, paths)).not.toThrow();
  for (const changed of [
    shell.replace("ubuntu.sources", "sources.list"), shell.replace("sourceparts/", "other/"), shell.replace("lists/", "other/"),
    `${shell}ROOT='/another-root'\n`, `${shell}EXTRA='x'\n`, shell.replace("SOURCE=", "SOURCE=$(touch /tmp/no); SOURCE="),
    shell.replace("SOURCE='", 'SOURCE="'), `${shell}\r`, "x".repeat(256 * 1024 + 1),
  ]) expect(() => assertEffectiveAptConfiguration(changed, dump, paths)).toThrow();
  for (const key of [
    "RootDir", "Binary::apt-get::RootDir", "Binary::apt-get::Dir", "Binary::apt-get::Dir::Etc",
    "Binary::apt-get::Dir::Etc::SourceList", "Binary::apt-get::Dir::Etc::SourceParts", "Binary::apt-get::Dir::State::Lists",
    "bINary::APT-get::DIR::State", "Binary::apt-get::Dir::Bin::Methods",
  ]) expect(() => assertEffectiveAptConfiguration(shell, `${dump}${key} "/other";\n`, paths)).toThrow();
  expect(() => assertEffectiveAptConfiguration(shell, `${dump}Binary::apt-get::Dir "";\n`, paths)).toThrow();
  for (const changed of ["malformed", `${dump}\0`, `${dump}\r`, "x".repeat(256 * 1024 + 1)]) {
    expect(() => assertEffectiveAptConfiguration(shell, changed, paths)).toThrow();
  }
});

function fixture(failAt = -1, configDump = dump) {
  const commands: SetupCommand[] = [];
  let sourceChecks = 0;
  const run = (command: SetupCommand) => {
    commands.push(command);
    if (commands.length === failAt) throw new Error("fixture command failed");
    if (command.args.includes("shell")) return shell;
    if (command.args.includes("dump")) return configDump;
    return "";
  };
  return { commands, execute: () => installScopedChromium(paths, "/opt/node/bin/node", "/repo/node_modules/playwright-core/cli.js", run, () => { sourceChecks++; }), sourceChecks: () => sourceChecks };
}

test("only dependency install is privileged and scoped; user browser download keeps the package manifest", () => {
  const owned = fixture();
  owned.execute();
  expect(owned.sourceChecks()).toBe(2);
  expect(owned.commands).toEqual([
    { executable: "/usr/bin/sudo", args: ["-n", "-u", "_apt", "--", "/usr/bin/test", "-r", paths.config], capture: true },
    { executable: "/usr/bin/sudo", args: ["-n", `APT_CONFIG=${paths.config}`, "/usr/bin/apt-config", "shell", "SOURCE", "Dir::Etc::SourceList/f", "PARTS", "Dir::Etc::SourceParts/d", "LISTS", "Dir::State::Lists/d", "ROOT", "RootDir"], capture: true },
    { executable: "/usr/bin/sudo", args: ["-n", `APT_CONFIG=${paths.config}`, "/usr/bin/apt-config", "dump"], capture: true },
    { executable: "/usr/bin/sudo", args: ["-n", `APT_CONFIG=${paths.config}`, "/opt/node/bin/node", "/repo/node_modules/playwright-core/cli.js", "install-deps", "chromium"], capture: false },
    { executable: "/opt/node/bin/node", args: ["/repo/node_modules/playwright-core/cli.js", "install", "chromium"], capture: false },
  ]);
});

test("failed traversal, config, dependencies or download never become successful browser admission", () => {
  for (let failAt = 1; failAt <= 5; failAt++) {
    const owned = fixture(failAt);
    expect(owned.execute).toThrow("fixture command failed");
    expect(owned.commands).toHaveLength(failAt);
    expect(owned.sourceChecks()).toBe(failAt < 4 ? 0 : 2);
  }
  const overridden = fixture(-1, `${dump}Binary::apt-get::Dir "/other";\n`);
  expect(overridden.execute).toThrow("override");
  expect(overridden.commands).toHaveLength(3);
  const beforeInstall: SetupCommand[] = [];
  expect(() => installScopedChromium(paths, "/node", "/cli", (command) => {
    beforeInstall.push(command);
    return command.args.includes("shell") ? shell : command.args.includes("dump") ? dump : "";
  }, () => { throw new Error("stock source already changed"); })).toThrow("stock source already changed");
  expect(beforeInstall).toHaveLength(3);
  let checks = 0;
  const unchanged = fixture();
  expect(() => installScopedChromium(paths, "/node", "/cli", (command) => {
    unchanged.commands.push(command);
    return command.args.includes("shell") ? shell : command.args.includes("dump") ? dump : "";
  }, () => { if (++checks === 2) throw new Error("stock source changed"); })).toThrow("stock source changed");
  expect(unchanged.commands).toHaveLength(4);
});
