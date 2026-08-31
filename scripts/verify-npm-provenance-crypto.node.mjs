import assert from "node:assert/strict";
import process from "node:process";

import { releaseSignerIdentity } from "./verify-npm-provenance-crypto.mjs";

const sha = "a".repeat(40);
const invocation = "https://github.com/hraness/hra/actions/runs/123/attempts/2";
const policy = releaseSignerIdentity("v0.1.0", sha, invocation);
assert.equal(
  policy.options.certificateIdentityURI,
  "^https://github\\.com/hraness/hra/\\.github/workflows/release\\.yml@refs/tags/v0\\.1\\.0$",
);
assert.equal(policy.options.certificateOIDs["1.3.6.1.4.1.57264.1.15"], "1343008607");
assert.equal(policy.options.certificateOIDs["1.3.6.1.4.1.57264.1.21"], invocation);
assert.equal(policy.options.certificateOIDs["1.3.6.1.4.1.57264.1.22"], "public");
assert.throws(() => releaseSignerIdentity(
  "v0.1.0",
  sha,
  "https://github.com/hraness/other/actions/runs/123/attempts/2",
));
assert.throws(() => releaseSignerIdentity("v0.1.0", "b".repeat(39), invocation));
process.stdout.write("node enforced exact npm provenance signer policy\n");
