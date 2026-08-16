import { expect, test } from "bun:test";
import {
  createBearerSecret,
  createLocator,
  formatCredentialToken,
  type SessionId,
} from "@hraness/agent-tasks-protocol";
import { assertAsyncProperty, assertProperty, fc } from "@hra-internal/test";

import { normalizeApiUrl, TaskctlClient } from "./client";

const credential = formatCredentialToken(
  createLocator(Uint8Array.from({ length: 26 }, (_, index) => index)),
  createBearerSecret(Uint8Array.from({ length: 32 }, (_, index) => index)),
);
const sessionId: SessionId = "ses_00000000000000000000000000";

test("property: arbitrary JSON responses cannot make the client throw or expose credentials", async () => {
  await assertAsyncProperty(
    fc.asyncProperty(fc.jsonValue(), async (value) => {
      const client = new TaskctlClient({
        apiUrl: "http://127.0.0.1:3211",
        fetch: () => Promise.resolve(Response.json(value)),
      });
      const result = await client.context({ credential, sessionId });
      expect(JSON.stringify(result)).not.toContain(credential);
    }),
  );
});

test("property: noncanonical 127/8 HTTP hosts are never treated as local exceptions", () => {
  assertProperty(
    fc.property(fc.integer({ min: 2, max: 254 }), (lastOctet) => {
      expect(normalizeApiUrl(`http://127.0.0.${lastOctet}:3211`)).toBeNull();
    }),
  );
});
