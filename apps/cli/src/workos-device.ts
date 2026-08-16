import {
  HumanClientError,
  loginWithWorkosDevice as loginWithPortableWorkosDevice,
  type WorkosDeviceLoginOptions,
} from "@hraness/hra-human-client";

import { TaskctlConfigError } from "./config";

export type {
  DeviceVerification,
  WorkosDeviceLoginOptions,
} from "@hraness/hra-human-client";

export async function loginWithWorkosDevice(
  options: WorkosDeviceLoginOptions,
): ReturnType<typeof loginWithPortableWorkosDevice> {
  try {
    return await loginWithPortableWorkosDevice(options);
  } catch (error) {
    if (error instanceof HumanClientError) {
      throw new TaskctlConfigError(
        error.code,
        error.code === "VALIDATION_ERROR"
          ? "TASKCTL_WORKOS_CLIENT_ID is invalid"
          : error.message,
      );
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
