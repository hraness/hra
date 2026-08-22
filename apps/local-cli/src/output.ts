export interface LocalCliIo {
  readonly stdout: { write(value: string): void };
  readonly stderr: { write(value: string): void };
}

export const processLocalCliIo: LocalCliIo = {
  stdout: { write: (value) => { process.stdout.write(value); } },
  stderr: { write: (value) => { process.stderr.write(value); } },
};

export function writeLocalCliJson(io: LocalCliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value)}\n`);
}

export function writeLocalCliError(io: LocalCliIo, code: string): void {
  io.stderr.write(`${JSON.stringify({ error: { code } })}\n`);
}
