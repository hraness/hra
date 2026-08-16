import { expect, test } from "bun:test";
import {
  createBearerSecret,
  createLocator,
  formatCredentialToken,
} from "@hraness/agent-tasks-protocol";
import { assertAsyncProperty, fc } from "@hra-internal/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeProfile } from "./config";

test("property: profile metadata rejects embedded bearer credentials", async () => {
  await assertAsyncProperty(
    fc.asyncProperty(
      fc.uint8Array({ minLength: 26, maxLength: 26 }),
      fc.uint8Array({ minLength: 32, maxLength: 32 }),
      async (locatorBytes, secretBytes) => {
        const token = formatCredentialToken(
          createLocator(locatorBytes),
          createBearerSecret(secretBytes),
        );
        const directory = await mkdtemp(join(tmpdir(), "taskctl-profile-property-"));
        try {
          let rejected: unknown;
          try {
            await writeProfile(
              {
                credentialFile: join(directory, "credentials.json"),
                profileFile: join(directory, "profile.json"),
              },
              {
                version: 1,
                apiUrl: "http://127.0.0.1:3211",
                agentId: token,
                scopes: ["tasks:read"],
              },
            );
          } catch (error) {
            rejected = error;
          }
          expect(rejected).toMatchObject({ code: "VALIDATION_ERROR" });
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    ),
  );
});
