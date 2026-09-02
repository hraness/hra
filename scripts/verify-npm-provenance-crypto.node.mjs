import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import process from "node:process";

import {
  canonicalAsciiDerUtf8String,
  releaseSignerIdentity,
} from "./verify-npm-provenance-crypto.mjs";

const sha = "a".repeat(40);
const invocation = "https://github.com/hraness/hra/actions/runs/123/attempts/2";
const repositorySubject = [
  "repo:hraness",
  "307125679/hra",
  "1343008607:ref:refs/tags/v0.1.7",
].join("@");
const policy = releaseSignerIdentity("v0.1.7", sha, invocation);
const decodeDerUtf8String = (value) => {
  const bytes = Buffer.from(value);
  assert.equal(bytes[0], 0x0c);
  assert.equal(bytes[1], bytes.byteLength - 2);
  return bytes.subarray(2).toString("utf8");
};
assert.equal(
  policy.options.certificateIdentityURI,
  "^https://github\\.com/hraness/hra/\\.github/workflows/release\\.yml@refs/tags/v0\\.1\\.7$",
);
assert.equal(policy.options.certificateOIDs["1.3.6.1.4.1.57264.1.2"], "push");
assert.equal(policy.options.certificateOIDs["1.3.6.1.4.1.57264.1.5"], "hraness/hra");
assert.equal(decodeDerUtf8String(policy.options.certificateOIDs["1.3.6.1.4.1.57264.1.15"]), "1343008607");
assert.equal(decodeDerUtf8String(policy.options.certificateOIDs["1.3.6.1.4.1.57264.1.21"]), invocation);
assert.equal(decodeDerUtf8String(policy.options.certificateOIDs["1.3.6.1.4.1.57264.1.22"]), "public");
assert.equal(
  decodeDerUtf8String(policy.options.certificateOIDs["1.3.6.1.4.1.57264.1.24"]),
  repositorySubject,
);
assert.deepEqual(
  Buffer.from(canonicalAsciiDerUtf8String("public")),
  Buffer.from([0x0c, 0x06, 0x70, 0x75, 0x62, 0x6c, 0x69, 0x63]),
);
assert.throws(() => canonicalAsciiDerUtf8String("a".repeat(128)));
assert.throws(() => releaseSignerIdentity(
  "v0.1.7",
  sha,
  "https://github.com/hraness/other/actions/runs/123/attempts/2",
));
assert.throws(() => releaseSignerIdentity("v0.1.7", "b".repeat(39), invocation));
process.stdout.write("node enforced exact npm provenance signer policy\n");
