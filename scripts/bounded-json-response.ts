const DEFAULT_MAXIMUM_JSON_BYTES = 512 * 1024;

export async function readBoundedJsonResponse(
  response: Response,
  label: string,
  maximumBytes = DEFAULT_MAXIMUM_JSON_BYTES,
): Promise<unknown> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error(`${label} has an invalid byte bound.`);
  }
  const declared = response.headers.get("content-length");
  if (
    declared !== null
    && (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > maximumBytes)
  ) throw new Error(`${label} exceeds its declared byte bound.`);
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error(`${label} has no body.`);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maximumBytes) throw new Error(`${label} exceeds its byte bound.`);
      chunks.push(item.value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* the bounded result remains authoritative */ }
    reader.releaseLock();
  }
  const payload = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as unknown;
  } catch {
    throw new Error(`${label} returned malformed JSON.`);
  }
}
