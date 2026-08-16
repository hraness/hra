import {
  errorExitCode,
  redactSecretsInText,
  type ErrorCode,
  type ErrorEnvelope,
  type RequestId,
} from "@hraness/agent-tasks-protocol";

export interface CliIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly readStdin: () => Promise<string>;
  readonly stdinIsTTY: boolean;
}

export interface CliFailure {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: ErrorEnvelope["error"]["details"];
  readonly requestId: RequestId;
}

export const processIo: CliIo = {
  stdout: (value) => {
    void process.stdout.write(value);
  },
  stderr: (value) => {
    void process.stderr.write(value);
  },
  readStdin: async () => await new Response(Bun.stdin.stream()).text(),
  stdinIsTTY: Boolean(process.stdin.isTTY),
};

function serialized(value: unknown, pretty: boolean): string {
  return redactSecretsInText(JSON.stringify(value, null, pretty ? 2 : undefined));
}

export function writeData(io: CliIo, value: unknown, json: boolean): void {
  io.stdout(`${serialized(value, !json)}\n`);
}

export function writeUsage(io: CliIo, usage: string, json: boolean): void {
  if (json) writeData(io, { usage }, true);
  else io.stdout(`${usage}\n`);
}

export function writeFailure(io: CliIo, failure: CliFailure, json: boolean): number {
  const details = failure.details ?? {};
  const envelope = {
    error: {
      code: failure.code,
      message: redactSecretsInText(failure.message),
      requestId: failure.requestId,
      details,
    },
  };
  if (json) io.stderr(`${serialized(envelope, false)}\n`);
  else {
    const idempotencySuffix =
      details.idempotencyKey === undefined
        ? ""
        : ` (idempotency-key: ${details.idempotencyKey})`;
    io.stderr(
      `taskctl: ${failure.code}: ${redactSecretsInText(failure.message)}${idempotencySuffix}\n`,
    );
  }
  return errorExitCode[failure.code];
}
