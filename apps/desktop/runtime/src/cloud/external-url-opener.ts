const MAX_EXTERNAL_URL_LENGTH = 8_192;

export function safeWorkOsVerificationUrl(value: string): string {
  if (value.length < 1 || value.length > MAX_EXTERNAL_URL_LENGTH) {
    throw new TypeError("The WorkOS verification URL has an invalid length.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("The WorkOS verification URL is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.length === 0 ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new TypeError("The WorkOS verification URL must be credential-free HTTPS.");
  }
  return url.toString();
}

/**
 * Opens only the provider-supplied HTTPS verification page. This is separate
 * from the Codex-account opener, whose origin allowlist intentionally accepts
 * only OpenAI authorization URLs.
 */
export class WorkOsExternalUrlOpener {
  async open(value: string): Promise<void> {
    const url = safeWorkOsVerificationUrl(value);
    const child = Bun.spawn(["/usr/bin/open", url], {
      env: { PATH: "/usr/bin:/bin" },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    if (await child.exited !== 0) {
      throw new Error("The WorkOS verification page could not be opened.");
    }
  }
}
