type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub included response body must be one JSON object.");
  }
  return value as JsonRecord;
}

export function parseGitHubIncludedJsonResponse(
  output: Uint8Array,
): Readonly<{ body: JsonRecord; status: number }> {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    throw new Error("GitHub included response is not canonical UTF-8.");
  }
  const separator = value.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n";
  const boundary = value.indexOf(separator);
  if (boundary <= 0 || value.indexOf(separator, boundary + separator.length) !== -1) {
    throw new Error("GitHub included response has an invalid message boundary.");
  }
  const header = value.slice(0, boundary);
  const bodyText = value.slice(boundary + separator.length);
  const lines = header.split(/\r?\n/u);
  const statusMatch = /^(?:HTTP\/1\.1|HTTP\/2(?:\.0)?) ([1-5][0-9]{2}) [\x20-\x7e]+$/u.exec(lines[0] ?? "");
  if (
    statusMatch === null
    || lines.slice(1).some((line) => !/^[A-Za-z0-9-]+: [\x20-\x7e]*$/u.test(line))
  ) throw new Error("GitHub included response has invalid HTTP metadata.");
  let body: unknown;
  try {
    body = JSON.parse(bodyText) as unknown;
  } catch {
    throw new Error("GitHub included response body is not JSON.");
  }
  return Object.freeze({ body: record(body), status: Number(statusMatch[1]) });
}
