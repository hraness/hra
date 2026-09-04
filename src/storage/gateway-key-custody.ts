/*
 * Local custody for the prose-autorespond gateway key.
 *
 * The key is a provider credential, so it never enters SQLite, argv, events,
 * evidence, logs, or the cloud projection. It lives in the same generational
 * secret custody that holds device credentials and cursor keys: an immutable
 * mode-0600 value under the state directory, addressed by a staged pointer, so
 * a replacement is atomic and a clear is provably scrubbed.
 *
 * Callers outside the daemon only ever learn whether a key is configured.
 */

import {
  GATEWAY_KEY_MAX_BYTES,
  GATEWAY_KEY_MIN_BYTES,
  gatewayKeySchema,
} from "../domain/values";

/** Custody slot holding the AI Gateway key. Never identity- or deployment-scoped. */
export const AUTORESPOND_GATEWAY_KEY_SLOT = "autorespond-gateway-key";

export class GatewayKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayKeyError";
  }
}

/*
 * The three-method custody surface shared with `CloudSecretCustodyPort`. Kept
 * structural so tests can substitute an in-memory implementation without
 * touching the filesystem custody machinery.
 */
export interface GatewaySecretCustodyPort {
  read(slot: string): Promise<Readonly<{ generation: number; value: string }> | null>;
  compareAndSwap(
    slot: string,
    expectedGeneration: number | null,
    value: string,
  ): Promise<Readonly<{ generation: number; value: string }> | null>;
  clearIfGeneration(slot: string, expectedGeneration: number): Promise<boolean>;
}

export interface GatewayKeyPort {
  /** Removes the configured key. Returns false when none was configured. */
  clear(): Promise<boolean>;
  /** Public status. The only gateway fact any command output may carry. */
  isConfigured(): Promise<boolean>;
  /** Daemon-internal read for the responder. Never rendered or logged. */
  read(): Promise<string | null>;
  /** Replaces any configured key. Throws `GatewayKeyError` on a rejected value. */
  set(key: string): Promise<void>;
}

/** Normalizes one descriptor read into a candidate key, or throws. */
export function normalizeGatewayKey(value: string): string {
  const trimmed = value.trim();
  const parsed = gatewayKeySchema.safeParse(trimmed);
  if (!parsed.success) {
    throw new GatewayKeyError(
      "The gateway key must be one line of printable ASCII between "
      + `${String(GATEWAY_KEY_MIN_BYTES)} and `
      + `${String(GATEWAY_KEY_MAX_BYTES)} characters.`,
    );
  }
  return parsed.data;
}

const MAXIMUM_CUSTODY_ATTEMPTS = 8;

export class CustodyGatewayKeyStore implements GatewayKeyPort {
  readonly #custody: GatewaySecretCustodyPort;

  constructor(custody: GatewaySecretCustodyPort) {
    this.#custody = custody;
  }

  async isConfigured(): Promise<boolean> {
    return await this.#custody.read(AUTORESPOND_GATEWAY_KEY_SLOT) !== null;
  }

  async read(): Promise<string | null> {
    const observed = await this.#custody.read(AUTORESPOND_GATEWAY_KEY_SLOT);
    return observed?.value ?? null;
  }

  async set(key: string): Promise<void> {
    const value = normalizeGatewayKey(key);
    for (let attempt = 0; attempt < MAXIMUM_CUSTODY_ATTEMPTS; attempt += 1) {
      const current = await this.#custody.read(AUTORESPOND_GATEWAY_KEY_SLOT);
      if (current?.value === value) return;
      const committed = await this.#custody.compareAndSwap(
        AUTORESPOND_GATEWAY_KEY_SLOT,
        current?.generation ?? null,
        value,
      );
      if (committed !== null) return;
    }
    throw new GatewayKeyError("The gateway key custody slot changed concurrently.");
  }

  async clear(): Promise<boolean> {
    for (let attempt = 0; attempt < MAXIMUM_CUSTODY_ATTEMPTS; attempt += 1) {
      const current = await this.#custody.read(AUTORESPOND_GATEWAY_KEY_SLOT);
      if (current === null) return false;
      if (await this.#custody.clearIfGeneration(AUTORESPOND_GATEWAY_KEY_SLOT, current.generation)) {
        return true;
      }
    }
    throw new GatewayKeyError("The gateway key custody slot changed concurrently.");
  }
}

/*
 * Deterministic in-process key holder for tests and for daemon boots where no
 * filesystem custody is available. It holds the value in memory only.
 */
export class InMemoryGatewayKeyStore implements GatewayKeyPort {
  #value: string | null;

  constructor(value: string | null = null) {
    this.#value = value === null ? null : normalizeGatewayKey(value);
  }

  isConfigured(): Promise<boolean> {
    return Promise.resolve(this.#value !== null);
  }

  read(): Promise<string | null> {
    return Promise.resolve(this.#value);
  }

  set(key: string): Promise<void> {
    this.#value = normalizeGatewayKey(key);
    return Promise.resolve();
  }

  clear(): Promise<boolean> {
    const had = this.#value !== null;
    this.#value = null;
    return Promise.resolve(had);
  }
}
