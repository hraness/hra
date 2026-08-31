import { expect, test } from "bun:test";
import { resolve } from "node:path";

import { npmCryptoEnvironment } from "./verify-npm-provenance";

test("uses the dependency-pinned Node runtime for cryptographic verification", async () => {
  const source = await Bun.file(resolve(import.meta.dir, "verify-npm-provenance.ts")).text();
  const helper = await Bun.file(resolve(import.meta.dir, "verify-npm-provenance-crypto.mjs")).text();
  expect(source).toContain('"node", resolve(import.meta.dir, "verify-npm-provenance-crypto.mjs")');
  expect(source).not.toContain('from "sigstore"');
  expect(helper).toContain('const { verify } = await import("sigstore")');
  expect(helper).toContain("releaseSignerIdentity(tag, sha, invocation)");
  expect(helper).toContain("verifyRegistryPublishBundle(bundle, input.registryKeys");
  expect(helper).toContain("tlogThreshold: 1");

  expect(npmCryptoEnvironment({
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-secret",
    GH_TOKEN: "github-secret",
    HOME: "/home/release",
    PATH: "/usr/bin:/bin",
    SSL_CERT_FILE: "/etc/ssl/cert.pem",
    UNRELATED_SECRET: "private",
  })).toEqual({
    HOME: "/home/release",
    PATH: "/usr/bin:/bin",
    SSL_CERT_FILE: "/etc/ssl/cert.pem",
  });
});

test("executes the Node helper policy and rejects tampered signer coordinates", async () => {
  const child = Bun.spawn([
    "node", resolve(import.meta.dir, "verify-npm-provenance-crypto.node.mjs"),
  ], {
    env: npmCryptoEnvironment(),
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode).toBe(0);
  expect(stdout).toBe("node enforced exact npm provenance signer policy\n");
  expect(stderr).toBe("");
});
