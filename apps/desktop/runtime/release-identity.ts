/** Compile-safe application identity consumed by the standalone gateway. */
export const hraReleaseIdentity = {
  version: "0.1.7",
  build: 8,
} as const satisfies Readonly<{ version: string; build: number }>;
