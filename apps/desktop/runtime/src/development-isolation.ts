import type { SecretStore } from "@hraness/hra-human-client";

export const rawDevelopmentSecretServicePrefix =
  "kitchen.hraness.source-development";

export function rawDevelopmentSecretService(service: string): string {
  if (service.length === 0) {
    throw new Error("A source-development secret service requires a name.");
  }
  return `${rawDevelopmentSecretServicePrefix}.${service}`;
}

/**
 * Keep raw ad-hoc builds useful without granting them access to any signed
 * product credential. Every operation is rewritten to a distinct Keychain
 * service before it reaches Bun.secrets.
 */
export function isolateRawDevelopmentSecrets(
  upstream: SecretStore,
): SecretStore {
  const isolated: SecretStore = {
    get: async (input) => await upstream.get({
      ...input,
      service: rawDevelopmentSecretService(input.service),
    }),
    set: async (input) => await upstream.set({
      ...input,
      service: rawDevelopmentSecretService(input.service),
    }),
    delete: async (input) => await upstream.delete({
      ...input,
      service: rawDevelopmentSecretService(input.service),
    }),
  };
  return Object.freeze(isolated);
}
