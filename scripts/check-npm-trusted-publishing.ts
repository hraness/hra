const child = Bun.spawn(["npm", "--version"], { stderr: "pipe", stdout: "pipe" });
const timer = setTimeout(() => child.kill(9), 10_000);
const [exitCode, stdout, stderr] = await Promise.all([
  child.exited,
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
]).finally(() => clearTimeout(timer));
if (exitCode !== 0 || stdout.length > 128 || stderr.length > 1_024) {
  throw new Error("npm --version did not return one bounded successful result.");
}
const version = stdout.trim();
const match = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/u.exec(version);
if (match === null) throw new Error("npm returned an invalid version.");
const major = Number(match[1]);
const minor = Number(match[2]);
const patch = Number(match[3]);
if (major < 11 || (major === 11 && (minor < 5 || (minor === 5 && patch < 1)))) {
  throw new Error(`npm ${version} is too old for trusted publishing; require >=11.5.1.`);
}
console.log(`npm ${version} supports trusted publishing.`);
