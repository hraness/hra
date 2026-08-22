/** Compile-safe application identity consumed by the standalone gateway. */
export const hraReleaseIdentity = {
  version: "0.1.12",
  build: 13,
} as const satisfies Readonly<{ version: string; build: number }>;
