import { expect } from "bun:test";

export async function expectPromiseToReject(
  promise: Promise<unknown>,
  expectedMessage?: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    if (expectedMessage !== undefined) expect(String(error)).toContain(expectedMessage);
    return;
  }
  throw new Error("Expected promise to reject.");
}
