import { err, ok, type Option, type Result } from "@hraness/result";
import { z } from "zod";

export { z };

/** Parse an owned boundary when the caller only needs valid-or-absent. */
export function parseOption<S extends z.ZodType>(schema: S, value: unknown): Option<z.infer<S>> {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

/** Parse an owned boundary while retaining structured Zod failure detail. */
export function parseResult<S extends z.ZodType>(schema: S, value: unknown): Result<z.infer<S>, z.ZodError> {
  const result = schema.safeParse(value);
  return result.success ? ok(result.data) : err(result.error);
}
