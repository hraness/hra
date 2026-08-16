import type { SecretStore } from "@hraness/hra-human-client";

export type { SecretStore } from "@hraness/hra-human-client";

export const bunSecretStore: SecretStore = {
  get: async (input) => await Bun.secrets.get(input),
  set: async (input) => {
    await Bun.secrets.set(input);
  },
  delete: async (input) => await Bun.secrets.delete(input),
};
