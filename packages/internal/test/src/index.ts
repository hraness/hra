import fc from "fast-check";
import type { IAsyncProperty, IProperty, Parameters } from "fast-check";

export { fc };
export type * from "fast-check";

export const propertyParameters = {
  numRuns: 200,
  interruptAfterTimeLimit: 10_000,
  markInterruptAsFailure: true,
} satisfies Parameters<unknown>;

/** Run a synchronous property with the repository defaults and native replay output. */
export function assertProperty<Values>(
  property: IProperty<Values>,
  overrides: Parameters<Values> = {},
): void {
  fc.assert(property, { ...propertyParameters, ...overrides });
}

/** Run an asynchronous property with the same bounded repository defaults. */
export async function assertAsyncProperty<Values>(
  property: IAsyncProperty<Values>,
  overrides: Parameters<Values> = {},
): Promise<void> {
  await fc.assert(property, { ...propertyParameters, ...overrides });
}
