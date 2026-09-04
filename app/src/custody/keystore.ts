/**
 * Device key custody for the browser.
 *
 * The signing and wrapping key pairs are generated non-extractable, so the
 * private halves can never be read back out of the browser by this code, by an
 * extension that evaluates in the page, or by anything that reads IndexedDB.
 * IndexedDB stores `CryptoKey` objects through the structured clone algorithm,
 * which is exactly why non-extractable keys can still survive a reload.
 *
 * Nothing else is persisted here: no account key, no token, no projection text.
 */
import {
  exportDevicePublicKey,
  generateDeviceSigningKeyPair,
  generateDeviceWrappingKeyPair,
  isOpaqueIdentifier,
} from "../hra/cloud";
import { randomOpaqueId } from "./registration";

const databaseName = "hra-device-custody";
const databaseVersion = 1;
const storeName = "device";
const recordKey = "current";

export type BrowserDeviceKeys = Readonly<{
  publicId: string;
  signing: CryptoKeyPair;
  signingPublicKey: string;
  wrapping: CryptoKeyPair;
  wrappingPublicKey: string;
}>;

type StoredDevice = Readonly<{
  publicId: string;
  signing: CryptoKeyPair;
  version: 1;
  wrapping: CryptoKeyPair;
}>;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName);
      }
    };
    request.onsuccess = () => { resolve(request.result); };
    request.onerror = () => { reject(new Error("Device key storage is unavailable.")); };
    request.onblocked = () => { reject(new Error("Device key storage is blocked.")); };
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = run(transaction.objectStore(storeName));
      request.onsuccess = () => { resolve(request.result); };
      request.onerror = () => { reject(new Error("Device key storage failed.")); };
      transaction.onabort = () => { reject(new Error("Device key storage failed.")); };
    });
  } finally {
    database.close();
  }
}

function isStoredDevice(value: unknown): value is StoredDevice {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1
    && isOpaqueIdentifier(record.publicId)
    && isKeyPair(record.signing)
    && isKeyPair(record.wrapping);
}

function isKeyPair(value: unknown): value is CryptoKeyPair {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.privateKey instanceof CryptoKey && record.publicKey instanceof CryptoKey;
}

async function describe(stored: StoredDevice): Promise<BrowserDeviceKeys> {
  return {
    publicId: stored.publicId,
    signing: stored.signing,
    signingPublicKey: await exportDevicePublicKey(stored.signing.publicKey),
    wrapping: stored.wrapping,
    wrappingPublicKey: await exportDevicePublicKey(stored.wrapping.publicKey),
  };
}

export async function readDeviceKeys(): Promise<BrowserDeviceKeys | null> {
  const stored = await withStore<unknown>("readonly", (store) => store.get(recordKey));
  if (!isStoredDevice(stored)) return null;
  if (stored.signing.privateKey.extractable || stored.wrapping.privateKey.extractable) {
    // An extractable private key was never written by this code. Refuse it
    // rather than enrolling a key that could have been exported.
    await clearDeviceKeys();
    return null;
  }
  return await describe(stored);
}

export async function createDeviceKeys(): Promise<BrowserDeviceKeys> {
  const [signing, wrapping] = await Promise.all([
    generateDeviceSigningKeyPair(false),
    generateDeviceWrappingKeyPair(false),
  ]);
  const stored: StoredDevice = {
    publicId: randomOpaqueId("device"),
    signing,
    version: 1,
    wrapping,
  };
  await withStore<IDBValidKey>("readwrite", (store) => store.put(stored, recordKey));
  return await describe(stored);
}

export async function readOrCreateDeviceKeys(): Promise<BrowserDeviceKeys> {
  return await readDeviceKeys() ?? await createDeviceKeys();
}

export async function clearDeviceKeys(): Promise<void> {
  await withStore<undefined>("readwrite", (store) => store.delete(recordKey));
}
