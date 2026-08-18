/** Compile-safe application identity consumed by the standalone gateway. */
export const hraReleaseIdentity = {
  version: "0.1.11",
  build: 12,
} as const satisfies Readonly<{ version: string; build: number }>;
