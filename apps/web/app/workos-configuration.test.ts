import { describe, expect, test } from "bun:test";

import {
  isNonEmptyEnvironmentValue,
  isWorkOSEnvironmentConfigured,
  missingWorkOSEnvironment,
  requiredWorkOSEnvironment,
} from "./workos-configuration";

const complete = Object.fromEntries(
  requiredWorkOSEnvironment.map((key) => [key, `configured-${key}`]),
);

describe("WorkOS configuration boundary", () => {
  test("accepts only a complete set of nonempty trimmed values", () => {
    expect(isWorkOSEnvironmentConfigured(complete)).toBeTrue();
    expect(isNonEmptyEnvironmentValue(" configured ")).toBeTrue();
    expect(isNonEmptyEnvironmentValue(" \t\n ")).toBeFalse();

    for (const key of requiredWorkOSEnvironment) {
      expect(isWorkOSEnvironmentConfigured({ ...complete, [key]: " \t " }), key)
        .toBeFalse();
      expect(missingWorkOSEnvironment({ ...complete, [key]: " \t " }))
        .toEqual([key]);
    }
  });

  test("reports every missing value in one stable order", () => {
    expect(missingWorkOSEnvironment({})).toEqual(requiredWorkOSEnvironment);
  });
});
