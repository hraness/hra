import { describe, expect, test } from "bun:test";
import { HRA_HUMAN_KEYCHAIN_SERVICE } from "@hraness/hra-human-client";

import { HRA_SESSION_SYNC_KEYCHAIN_SERVICE } from
  "../src/cloud/session-sync-key-custody";
import {
  isolateRawDevelopmentSecrets,
  rawDevelopmentSecretService,
  rawDevelopmentSecretServicePrefix,
} from "../src/development-isolation";

describe("raw development custody isolation", () => {
  test("rewrites human, session-sync, and runner custody away from production services", async () => {
    const productionServices = [
      HRA_HUMAN_KEYCHAIN_SERVICE,
      HRA_SESSION_SYNC_KEYCHAIN_SERVICE,
      "com.jungle.taskctl",
    ];
    const observed: Array<Readonly<{
      operation: "get" | "set" | "delete";
      service: string;
    }>> = [];
    const isolated = isolateRawDevelopmentSecrets({
      get: (input) => {
        observed.push({ operation: "get", service: input.service });
        return Promise.resolve(null);
      },
      set: (input) => {
        observed.push({ operation: "set", service: input.service });
        return Promise.resolve();
      },
      delete: (input) => {
        observed.push({ operation: "delete", service: input.service });
        return Promise.resolve(false);
      },
    });

    for (const service of productionServices) {
      await isolated.get({ service, name: "credential" });
      await isolated.set({ service, name: "credential", value: "secret" });
      await isolated.delete({ service, name: "credential" });
    }

    expect(observed.map(({ service }) => service)).toEqual(
      productionServices.flatMap((service) => [
        rawDevelopmentSecretService(service),
        rawDevelopmentSecretService(service),
        rawDevelopmentSecretService(service),
      ]),
    );
    expect(observed.every(({ service }) =>
      service.startsWith(`${rawDevelopmentSecretServicePrefix}.`)))
      .toBeTrue();
    expect(observed.some(({ service }) => productionServices.includes(service)))
      .toBeFalse();
  });
});
