/** Compile-safe application identity consumed by the standalone gateway. */
export const hraReleaseIdentity = {
  version: "0.1.14",
  build: 15,
} as const satisfies Readonly<{ version: string; build: number }>;
