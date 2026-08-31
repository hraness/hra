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
if (version !== "11.19.0") {
  throw new Error(`npm ${version} is not the reviewed trusted-publishing client 11.19.0.`);
}
console.log("npm 11.19.0 is the reviewed trusted-publishing client.");
