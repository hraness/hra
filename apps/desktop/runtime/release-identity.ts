/** Compile-safe application identity consumed by the standalone gateway. */
export const hraReleaseIdentity = {
  version: "0.1.8",
  build: 9,
} as const satisfies Readonly<{ version: string; build: number }>;
