const unsafeTerminalScalar = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const safeJoinControl = /[\u200c\u200d]/u;

const jsonEscapeScalar = (scalar: string): string => {
  const codePoint = scalar.codePointAt(0);
  if (codePoint === undefined) return "\\ufffd";
  if (codePoint <= 0xFFFF) return `\\u${codePoint.toString(16).padStart(4, "0")}`;
  const adjusted = codePoint - 0x10000;
  const high = 0xD800 + (adjusted >> 10);
  const low = 0xDC00 + (adjusted & 0x3FF);
  return `\\u${high.toString(16)}\\u${low.toString(16)}`;
};

/** The exact JSON serializer used for visible local-terminal output. */
export const terminalSafeJson = (value: unknown, space?: number): string => {
  const candidate: unknown = JSON.stringify(value, null, space);
  const serialized = typeof candidate === "string" ? candidate : "null";
  let output = "";
  for (const scalar of serialized) {
    output += scalar === "\n"
      ? scalar
      : unsafeTerminalScalar.test(scalar) && !safeJoinControl.test(scalar)
        ? jsonEscapeScalar(scalar)
        : scalar;
  }
  return output;
};

export const terminalSafeJsonBytes = (value: unknown, space?: number): number =>
  Buffer.byteLength(terminalSafeJson(value, space), "utf8");

export type BoundedWorkReadCommand =
  | "work.snapshot"
  | "work.task"
  | "work.poll"
  | "work.events";

export const workReadSuccessWireDocument = (
  command: BoundedWorkReadCommand,
  data: unknown,
): string => `${terminalSafeJson({ ok: true, version: 1, command, data })}\n`;

export const workReadSuccessWireBytes = (
  command: BoundedWorkReadCommand,
  data: unknown,
): number => Buffer.byteLength(workReadSuccessWireDocument(command, data), "utf8");
