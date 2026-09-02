// UUIDv7 idempotency keys carry their creation time in the first 48 bits so
// authorities can expire stale keys without a second timestamp field.

const uuidV7Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function isUuidV7(value: unknown): value is string {
  return typeof value === "string" && uuidV7Pattern.test(value);
}

export function createCloudUuidV7(now: number = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now >= 2 ** 48) {
    throw new Error("System clock cannot produce a cloud idempotency key.");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = now;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp % 256;
    timestamp = Math.floor(timestamp / 256);
  }
  const randomSix = bytes[6];
  const randomEight = bytes[8];
  if (randomSix === undefined || randomEight === undefined) {
    throw new Error("Cryptographic randomness is unavailable.");
  }
  bytes[6] = 0x70 | (randomSix & 0x0f);
  bytes[8] = 0x80 | (randomEight & 0x3f);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
