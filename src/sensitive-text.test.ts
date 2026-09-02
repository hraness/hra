import { describe, expect, test } from "bun:test";

import fc from "fast-check";

import { redactCompleteSensitiveText, unlabelledSecretPatterns } from "./sensitive-text";
import { StreamingSensitiveRedactor } from "./streaming-sensitive-text";

const replacement = "[redacted]";

// Synthetic shapes only. None of these values is a real credential.
const unlabelledSecretFixtures = [
  { name: "aws access key id", secret: ["AKIA", "IOSFODNN7EXAMPLE"].join("") },
  { name: "aws secret access key", secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
  { name: "google api key", secret: `AIza${"Sy".repeat(17)}A` },
  { name: "gitlab personal access token", secret: `glpat-${"a1B2".repeat(5)}` },
  { name: "npm access token", secret: `npm_${"Ab9".repeat(12)}` },
  { name: "hugging face token", secret: `hf_${"Qw3".repeat(12)}` },
  { name: "github personal access token", secret: `ghp_${"z9".repeat(18)}` },
  { name: "github fine-grained token", secret: `github_pat_${"Xy7".repeat(12)}` },
  { name: "anthropic api key", secret: `sk-ant-api03-${"Kq".repeat(24)}` },
  { name: "openai project key", secret: `sk-proj-${"Mn".repeat(24)}` },
] as const;

const benignValues = [
  "a plain sentence with no credentials in it",
  "0123456789abcdef0123456789abcdef01234567",
  "ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMN",
  "abcdefghijklmnopqrstuvwxyzabcdefghijklmn",
  "user@example.com visited https://example.com/path?q=1",
  "commit 3f9c1e4d7a2b8c6e5d4f3a2b1c0d9e8f7a6b5c4d",
  "the shelf holds glpat and npm_ and hf_ as bare words",
  "AIzaTooShort and npm_tooshort and hf_short",
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0Z3VS5JJcds3xfn",
] as const;

const secretArbitrary = fc.constantFrom(...unlabelledSecretFixtures.map((fixture) => fixture.secret));
const fillerArbitrary = fc.stringMatching(/^[A-Za-z0-9 .,:;()\n\t_-]{0,24}$/u);

describe("unlabelled secret redaction", () => {
  test("redacts each vendor shape in prose", () => {
    for (const fixture of unlabelledSecretFixtures) {
      const redacted = redactCompleteSensitiveText(`log: ${fixture.secret} done`, replacement);
      expect(redacted, fixture.name).toBe(`log: ${replacement} done`);
    }
  });

  test("leaves benign words, hashes, and short prefixes alone", () => {
    for (const value of benignValues) {
      expect(redactCompleteSensitiveText(value, replacement)).toBe(value);
    }
  });

  test("declares one pattern per vendor shape", () => {
    expect(unlabelledSecretPatterns).toHaveLength(10);
    for (const entry of unlabelledSecretPatterns) {
      expect(() => new RegExp(entry.source, "u")).not.toThrow();
    }
  });

  test("is idempotent and stays within twice the input plus one replacement", () => {
    fc.assert(fc.property(
      fc.array(fc.oneof(fillerArbitrary, secretArbitrary), { maxLength: 6 }),
      (parts) => {
        const value = parts.join(" ");
        const once = redactCompleteSensitiveText(value, replacement);
        const twice = redactCompleteSensitiveText(once, replacement);
        expect(twice).toBe(once);
        expect(once.length).toBeLessThanOrEqual(2 * value.length + replacement.length);
        for (const fixture of unlabelledSecretFixtures) expect(once).not.toContain(fixture.secret);
      },
    ), { numRuns: 400 });
  });

  test("streams each vendor shape at least as conservatively as complete redaction", () => {
    for (const fixture of unlabelledSecretFixtures) {
      const text = `prefix ${fixture.secret} suffix`;
      for (let split = 0; split <= text.length; split += 1) {
        const redactor = new StreamingSensitiveRedactor();
        let output = redactor.push(text.slice(0, split));
        output += redactor.push(text.slice(split));
        output += redactor.push("", true);
        expect(output, `${fixture.name}@${split}`).not.toContain(fixture.secret);
        expect(output).toContain("[protected]");
        expect(redactCompleteSensitiveText(output, "[protected]")).toBe(output);
      }
    }
  });
});
