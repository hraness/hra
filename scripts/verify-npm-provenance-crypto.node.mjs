import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import process from "node:process";

import {
  canonicalAsciiDerUtf8String,
  releaseSignerIdentity,
} from "./verify-npm-provenance-crypto.mjs";

const sha = "a".repeat(40);
const invocation = "https://github.com/hraness/oompa/actions/runs/123/attempts/2";
const repositorySubject = [
  "repo:hraness",
  "307125679/oompa",
  "1343008607:environment:npm-release",
].join("@");
const retiredRefSubject = [
  "repo:hraness",
  "307125679/oompa",
  "1343008607:ref:refs/tags/v0.6.0",
].join("@");
const policy = releaseSignerIdentity("v0.6.0", sha, invocation);
const decodeDerUtf8String = (value) => {
  const bytes = Buffer.from(value);
  assert.equal(bytes[0], 0x0c);
  assert.equal(bytes[1], bytes.byteLength - 2);
  return bytes.subarray(2).toString("utf8");
};
assert.equal(
  policy.options.certificateIdentityURI,
  "^https://github\\.com/hraness/oompa/\\.github/workflows/release\\.yml@refs/tags/v0\\.6\\.0$",
);
assert.equal(policy.options.certificateOIDs["1.3.6.1.4.1.57264.1.2"], "push");
assert.equal(policy.options.certificateOIDs["1.3.6.1.4.1.57264.1.5"], "hraness/oompa");
assert.equal(decodeDerUtf8String(policy.options.certificateOIDs["1.3.6.1.4.1.57264.1.15"]), "1343008607");
assert.equal(decodeDerUtf8String(policy.options.certificateOIDs["1.3.6.1.4.1.57264.1.21"]), invocation);
assert.equal(decodeDerUtf8String(policy.options.certificateOIDs["1.3.6.1.4.1.57264.1.22"]), "public");
assert.equal(decodeDerUtf8String(policy.options.certificateOIDs["1.3.6.1.4.1.57264.1.23"]), "npm-release");
assert.equal(
  decodeDerUtf8String(policy.options.certificateOIDs["1.3.6.1.4.1.57264.1.24"]),
  repositorySubject,
);
assert.equal(
  Object.values(policy.options.certificateOIDs).includes(
    canonicalAsciiDerUtf8String(retiredRefSubject),
  ),
  false,
);
const nextTagPolicy = releaseSignerIdentity("v0.6.1", sha, invocation);
assert.equal(
  nextTagPolicy.options.certificateOIDs["1.3.6.1.4.1.57264.1.23"],
  policy.options.certificateOIDs["1.3.6.1.4.1.57264.1.23"],
);
assert.equal(
  nextTagPolicy.options.certificateOIDs["1.3.6.1.4.1.57264.1.24"],
  policy.options.certificateOIDs["1.3.6.1.4.1.57264.1.24"],
);
assert.equal(
  nextTagPolicy.options.certificateIdentityURI,
  "^https://github\\.com/hraness/oompa/\\.github/workflows/release\\.yml@refs/tags/v0\\.6\\.1$",
);
assert.equal(
  nextTagPolicy.options.certificateOIDs["1.3.6.1.4.1.57264.1.6"],
  "refs/tags/v0.6.1",
);
assert.equal(
  decodeDerUtf8String(nextTagPolicy.options.certificateOIDs["1.3.6.1.4.1.57264.1.14"]),
  "refs/tags/v0.6.1",
);
assert.equal(
  decodeDerUtf8String(nextTagPolicy.options.certificateOIDs["1.3.6.1.4.1.57264.1.18"]),
  "https://github.com/hraness/oompa/.github/workflows/release.yml@refs/tags/v0.6.1",
);
for (const oid of [
  "1.3.6.1.4.1.57264.1.6",
  "1.3.6.1.4.1.57264.1.14",
  "1.3.6.1.4.1.57264.1.18",
]) {
  assert.notEqual(
    nextTagPolicy.options.certificateOIDs[oid],
    policy.options.certificateOIDs[oid],
  );
}
assert.notEqual(nextTagPolicy.options.certificateIdentityURI, policy.options.certificateIdentityURI);
assert.deepEqual(
  Buffer.from(canonicalAsciiDerUtf8String("public")),
  Buffer.from([0x0c, 0x06, 0x70, 0x75, 0x62, 0x6c, 0x69, 0x63]),
);
assert.throws(() => canonicalAsciiDerUtf8String("a".repeat(128)));
assert.throws(() => releaseSignerIdentity(
  "v0.6.0",
  sha,
  "https://github.com/hraness/other/actions/runs/123/attempts/2",
));
assert.throws(() => releaseSignerIdentity("v0.6.0", "b".repeat(39), invocation));
process.stdout.write("node enforced exact npm provenance signer policy\n");
