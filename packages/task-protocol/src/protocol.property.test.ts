import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import {
  createBearerSecret,
  createLocator,
  agentCredentialViewSchema,
  formatCredentialToken,
  parseCredentialToken,
  redactSecret,
  redactSecretsInText,
} from "./index";

test("valid random tokens parse exactly and redact every secret", () => {
  assertProperty(
    fc.property(
      fc.uint8Array({ minLength: 32, maxLength: 32 }),
      fc.uint8Array({ minLength: 26, maxLength: 26 }),
      (secretBytes, locatorBytes) => {
        const secret = createBearerSecret(secretBytes);
        const locator = createLocator(locatorBytes);
        const token = formatCredentialToken(locator, secret);

        expect(parseCredentialToken(token)).toEqual({ locator, secret });
        expect(redactSecret(token)).not.toContain(secret);
        const redacted = redactSecretsInText(`one=${token}; two=${token}`);
        expect(redacted).not.toContain(secret);
        expect(redacted).not.toContain(locator);
      },
    ),
  );
});

test("arbitrary strings never make token parsing throw", () => {
  assertProperty(
    fc.property(fc.string(), (value) => {
      expect(() => parseCredentialToken(value)).not.toThrow();
    }),
  );
});

test("known opaque refresh tokens are redacted in arbitrary provider diagnostics", () => {
  assertProperty(
    fc.property(
      fc
        .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"), {
          minLength: 20,
          maxLength: 120,
        })
        .map((characters) => characters.join("")),
      fc.string(),
      (refreshToken, diagnostic) => {
        const source = `${diagnostic}\nrefresh_token=${refreshToken}\nprovider=${refreshToken}`;
        expect(redactSecretsInText(source, [refreshToken])).not.toContain(refreshToken);
      },
    ),
  );
});

test("credential administration accepts only the public locator, never a bearer token", () => {
  assertProperty(
    fc.property(
      fc.uint8Array({ minLength: 32, maxLength: 32 }),
      fc.uint8Array({ minLength: 26, maxLength: 26 }),
      (secretBytes, locatorBytes) => {
        const secret = createBearerSecret(secretBytes);
        const locator = createLocator(locatorBytes);
        const token = formatCredentialToken(locator, secret);
        const metadata = {
          id: locator,
          agentId: "agent-id",
          workspaceId: "workspace-id",
          scopes: ["tasks:read"],
          status: "active",
          createdAt: 1,
          expiresAt: 2,
          lastUsedAt: 1,
        };

        expect(agentCredentialViewSchema.safeParse(metadata).success).toBeTrue();
        expect(agentCredentialViewSchema.safeParse({ ...metadata, id: token }).success).toBeFalse();
        expect(JSON.stringify(agentCredentialViewSchema.parse(metadata))).not.toContain(secret);
      },
    ),
  );
});
