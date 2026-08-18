/** Compile-safe application identity consumed by the standalone gateway. */
export const hraReleaseIdentity = {
  version: "0.1.9",
  build: 10,
} as const satisfies Readonly<{ version: string; build: number }>;
