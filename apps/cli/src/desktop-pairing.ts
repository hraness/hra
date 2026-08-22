import {
  HumanClientError,
  loginWithDesktopPairing as loginWithPortableDesktopPairing,
  type DesktopPairingLoginOptions,
} from "@hraness/hra-human-client";

import { TaskctlConfigError } from "./config";

export type {
  DesktopPairingLoginOptions,
  DesktopPairingVerification,
} from "@hraness/hra-human-client";

export async function loginWithDesktopPairing(
  options: DesktopPairingLoginOptions,
): ReturnType<typeof loginWithPortableDesktopPairing> {
  try {
    return await loginWithPortableDesktopPairing(options);
  } catch (error) {
    if (error instanceof HumanClientError) {
      throw new TaskctlConfigError(error.code, error.message);
    }
    throw error;
  }
}

export function openVerificationUrl(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  const child = Bun.spawn(command, {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  child.unref();
  return Promise.resolve();
}
