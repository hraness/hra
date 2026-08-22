const MAX_EXTERNAL_URL_LENGTH = 8_192;
const pairingPathPattern =
  /^\/pair\/desktop\/pair_[0-9A-HJKMNP-TV-Z]{26}$/u;

export function safeDesktopPairingUrl(
  value: string,
  expectedWebOrigin: string,
): string {
  if (value.length < 1 || value.length > MAX_EXTERNAL_URL_LENGTH) {
    throw new TypeError("The desktop pairing URL has an invalid length.");
  }
  let url: URL;
  let expected: URL;
  try {
    url = new URL(value);
    expected = new URL(expectedWebOrigin);
  } catch {
    throw new TypeError("The desktop pairing URL is invalid.");
  }
  if (
    url.origin !== expected.origin ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    !pairingPathPattern.test(url.pathname)
  ) {
    throw new TypeError(
      "The desktop pairing URL must use the configured browser origin and pairing path.",
    );
  }
  return url.toString();
}

/** Opens only the exact configured HRA browser pairing route. */
export class DesktopPairingExternalUrlOpener {
  readonly #webOrigin: string;

  constructor(webOrigin: string) {
    this.#webOrigin = new URL(webOrigin).origin;
  }

  async open(value: string): Promise<void> {
    const url = safeDesktopPairingUrl(value, this.#webOrigin);
    const child = Bun.spawn(["/usr/bin/open", url], {
      env: { PATH: "/usr/bin:/bin" },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    if (await child.exited !== 0) {
      throw new Error("The desktop pairing page could not be opened.");
    }
  }
}
