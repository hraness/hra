import { describe, expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";
import { codexChildEnvironment } from "../src/security/environment";
import { compatibilityDiagnostic, publicFailureMessage } from "../src/security/redaction";

describe("gateway security policies", () => {
  test("child environments copy only the explicit allowlist", () => {
    const environment = codexChildEnvironment({
      codexHome: "/private/codex/home",
      gitRoot: "/private/runtime/git",
      home: "/private/user",
      temporaryDirectory: "/private/tmp",
      parent: {
        LANG: "en_US.UTF-8",
        HTTP_PROXY: "https://credential@example.invalid",
        DYLD_INSERT_LIBRARIES: "/tmp/injected.dylib",
        NODE_OPTIONS: "--require /tmp/injected.js",
        OPENAI_API_KEY: "secret",
      },
    });
    expect(environment.LANG).toBe("en_US.UTF-8");
    expect(environment).not.toHaveProperty("HTTP_PROXY");
    expect(environment).not.toHaveProperty("DYLD_INSERT_LIBRARIES");
    expect(environment).not.toHaveProperty("NODE_OPTIONS");
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
  });

  test("arbitrary protocol methods never become raw diagnostics", () => {
    assertProperty(
      fc.property(fc.string(), (method) => {
        const diagnostic = compatibilityDiagnostic("unknownServerRequest", method, 1);
        expect(diagnostic.method.length).toBeLessThanOrEqual(160);
        expect(diagnostic.method === "<invalid-method>" || /^[A-Za-z0-9_./:-]+$/u.test(diagnostic.method)).toBeTrue();
      }),
    );
  });

  test("foreign error messages are never surfaced", () => {
    const secret = "Bearer hidden-token /Users/private prompt@example.com";
    expect(publicFailureMessage(new Error(secret))).toBe("The operation failed.");
    expect(publicFailureMessage(new Error(secret))).not.toContain(secret);
  });
});
