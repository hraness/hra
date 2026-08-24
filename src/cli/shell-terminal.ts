import { clearScreenDown, cursorTo, moveCursor } from "node:readline";
import { createInterface, type Interface } from "node:readline/promises";
import { Transform } from "node:stream";
import { stripVTControlCharacters } from "node:util";

type ShellRawSignal = "SIGQUIT" | "SIGTSTP";
type ShellLifecycleSignal = "SIGHUP" | "SIGINT" | "SIGQUIT" | "SIGTERM" | "SIGTSTP";

export type ShellTerminalLifecycleHooks = Readonly<{
  onSignal: (signal: ShellLifecycleSignal, listener: () => void) => () => void;
  resignal: (signal: ShellLifecycleSignal) => void;
}>;

export type ShellTerminalCoordinatorInput = Readonly<{
  flushInput?: () => void;
  input: NodeJS.ReadableStream;
  lifecycleHooks?: ShellTerminalLifecycleHooks;
  output: NodeJS.WritableStream;
  resignal?: (signal: ShellRawSignal) => void;
  terminal?: boolean;
}>;

type ActiveQuestion = Readonly<{
  controller: AbortController;
  interruptForDisplayFailure: () => void;
  prompt: string;
  terminal: Interface;
}>;

const isTerminalStream = (stream: NodeJS.WritableStream): boolean =>
  (stream as NodeJS.WritableStream & { isTTY?: unknown }).isTTY === true;

const isClosedReadlineError = (error: unknown): boolean =>
  error !== null
  && typeof error === "object"
  && "code" in error
  && error.code === "ERR_USE_AFTER_CLOSE";

const liveBlock = (value: string): string => value.endsWith("\n") ? value : `${value}\n`;
const bufferedLineLimit = 256;
const bufferedLineCodeUnitLimit = 256 * 1024;
const heldLiveCodeUnitLimit = 256 * 1024;
const heldLiveTruncationNotice = "\n[additional live updates omitted while the command was active]\n";
const liveWriteCodeUnitLimit = 256 * 1024;
const liveWriteTruncationNotice = "\n[additional live output omitted because one update exceeded the terminal bound]\n";
const liveBackpressureNotice = "\n[additional live updates omitted while the terminal was backpressured]\n";
const rawSignalTailQuietMilliseconds = 50;
const rawSignalTailMaximumMilliseconds = 500;
const shellLifecycleSignals: readonly ShellLifecycleSignal[] = process.platform === "win32"
  ? ["SIGINT", "SIGTERM"]
  : ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGTSTP"];

const bestEffortWrite = (output: NodeJS.WritableStream, value: string): boolean => {
  try {
    output.write(value);
    return true;
  } catch {
    // Input quarantine must retain authority even when the display is unavailable.
    return false;
  }
};

class IncrementallyBoundedLineInput extends Transform {
  readonly #maximumBytes: number;
  readonly #onOverflow: () => void;
  readonly #onSignal: (signal: ShellRawSignal) => void;
  readonly #onTail: (value: Buffer) => void;
  readonly #onDropLeadingLfChange: (value: boolean) => void;
  #bytesSinceLineBoundary = 0;
  #dropLeadingLf: boolean;
  #lineForwarded = false;
  #overflowed = false;

  constructor(
    maximumBytes: number,
    onOverflow: () => void,
    onSignal: (signal: ShellRawSignal) => void,
    onTail: (value: Buffer) => void,
    dropLeadingLf: boolean,
    onDropLeadingLfChange: (value: boolean) => void,
  ) {
    super();
    this.#maximumBytes = maximumBytes;
    this.#onOverflow = onOverflow;
    this.#onSignal = onSignal;
    this.#onTail = onTail;
    this.#dropLeadingLf = dropLeadingLf;
    this.#onDropLeadingLfChange = onDropLeadingLfChange;
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.#overflowed) {
      chunk.fill(0);
      callback();
      return;
    }
    let offset = 0;
    if (this.#dropLeadingLf && chunk.length > 0) {
      this.#setDropLeadingLf(false);
      if (chunk[0] === 0x0a) offset = 1;
    }
    for (let index = offset; index < chunk.length; index += 1) {
      const codeUnit = chunk[index];
      const signal = codeUnit === 0x1a
        ? "SIGTSTP"
        : codeUnit === 0x1c
          ? "SIGQUIT"
          : null;
      if (signal === null) continue;
      this.#overflowed = true;
      chunk.fill(0);
      this.#onSignal(signal);
      callback();
      return;
    }
    if (this.#lineForwarded) {
      this.#captureTail(chunk.subarray(offset));
      callback();
      return;
    }
    let boundary = -1;
    for (let index = offset; index < chunk.length; index += 1) {
      const codeUnit = chunk[index];
      if (codeUnit === 0x0a || codeUnit === 0x0d) {
        boundary = index;
        break;
      }
      this.#bytesSinceLineBoundary += 1;
      if (this.#bytesSinceLineBoundary <= this.#maximumBytes) continue;
      this.#overflowed = true;
      chunk.fill(0);
      this.#onOverflow();
      callback();
      return;
    }
    if (boundary < 0) {
      if (offset < chunk.length) this.push(chunk.subarray(offset));
      callback();
      return;
    }
    this.push(chunk.subarray(offset, boundary + 1));
    this.#lineForwarded = true;
    this.#setDropLeadingLf(chunk[boundary] === 0x0d);
    this.#captureTail(chunk.subarray(boundary + 1));
    callback();
  }

  #captureTail(value: Buffer): void {
    if (value.length === 0) return;
    const normalized = Buffer.alloc(value.length);
    let length = 0;
    for (const codeUnit of value) {
      if (this.#dropLeadingLf) {
        this.#setDropLeadingLf(false);
        if (codeUnit === 0x0a) continue;
      }
      normalized[length] = codeUnit;
      length += 1;
      if (codeUnit === 0x0d) this.#setDropLeadingLf(true);
    }
    if (length === 0) {
      normalized.fill(0);
      return;
    }
    this.#onTail(normalized.subarray(0, length));
  }

  #setDropLeadingLf(value: boolean): void {
    if (this.#dropLeadingLf === value) return;
    this.#dropLeadingLf = value;
    this.#onDropLeadingLfChange(value);
  }
}

export const createIncrementallyBoundedLineInput = (
  maximumBytes: number,
  onOverflow: () => void,
  source?: NodeJS.ReadableStream,
  input: Readonly<{
    dropLeadingLf?: boolean;
    onDropLeadingLfChange?: (value: boolean) => void;
    onSignal?: (signal: ShellRawSignal) => void;
    onTail?: (value: Buffer) => void;
  }> = {},
): Transform => {
  const bounded = new IncrementallyBoundedLineInput(
    maximumBytes,
    onOverflow,
    input.onSignal ?? (() => undefined),
    input.onTail ?? (() => undefined),
    input.dropLeadingLf ?? false,
    input.onDropLeadingLfChange ?? (() => undefined),
  );
  const tty = source as NodeJS.ReadableStream & {
    isRaw?: boolean;
    isTTY?: unknown;
    setRawMode?: (mode: boolean) => unknown;
  } | undefined;
  if (tty?.isTTY === true) {
    Object.defineProperty(bounded, "isTTY", { configurable: true, value: true });
  }
  if (typeof tty?.setRawMode === "function") {
    Object.defineProperty(bounded, "isRaw", {
      configurable: true,
      get: () => tty.isRaw,
    });
    Object.defineProperty(bounded, "setRawMode", {
      configurable: true,
      value: (mode: boolean) => {
        let lastFailure: unknown = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            tty.setRawMode?.(mode);
            if (tty.isRaw === mode) return bounded;
            lastFailure = new Error("The terminal did not enter the requested raw mode.");
          } catch (error: unknown) {
            lastFailure = error;
            if (tty.isRaw === mode) return bounded;
          }
        }
        throw lastFailure;
      },
    });
  }
  return bounded;
};

const boundedLiveWrite = (value: string): string => {
  if (value.length <= liveWriteCodeUnitLimit) return value;
  let prefix = value.slice(0, liveWriteCodeUnitLimit);
  const finalCodeUnit = prefix.charCodeAt(prefix.length - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) prefix = prefix.slice(0, -1);
  return `${prefix}${liveWriteTruncationNotice}`;
};

type TerminalDisplayPosition = Readonly<{ cols: number; rows: number }>;
const terminalGraphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const advanceTerminalPosition = (
  position: TerminalDisplayPosition,
  width: number,
  columns: number,
  atomic = true,
): TerminalDisplayPosition => {
  const origin = atomic
    && width > 1
    && width <= columns
    && position.cols > 0
    && position.cols + width > columns
    ? { cols: 0, rows: position.rows + 1 }
    : position;
  const advanced = origin.cols + width;
  return {
    cols: advanced % columns,
    rows: origin.rows + Math.floor(advanced / columns),
  };
};

const terminalDisplayPosition = (value: string, columns: number): TerminalDisplayPosition => {
  let position: TerminalDisplayPosition = { cols: 0, rows: 0 };
  for (const { segment } of terminalGraphemeSegmenter.segment(stripVTControlCharacters(value))) {
    if (segment === "\n") {
      position = { cols: 0, rows: position.rows + 1 };
      continue;
    }
    if (segment === "\r") {
      position = { ...position, cols: 0 };
      continue;
    }
    const width = segment === "\t"
      ? 8 - (position.cols % 8)
      : Bun.stringWidth(segment);
    position = advanceTerminalPosition(position, width, columns, segment !== "\t");
  }
  return position;
};

const expandTerminalTabs = (
  value: string,
  initial: TerminalDisplayPosition,
  columns: number,
): Readonly<{ position: TerminalDisplayPosition; value: string }> => {
  let expanded = "";
  let position = initial;
  for (const { segment } of terminalGraphemeSegmenter.segment(value)) {
    if (segment === "\t") {
      const width = 8 - (position.cols % 8);
      expanded += " ".repeat(width);
      position = advanceTerminalPosition(position, width, columns, false);
      continue;
    }
    expanded += segment;
    position = advanceTerminalPosition(position, Bun.stringWidth(segment), columns);
  }
  return { position, value: expanded };
};

export const discardReadableUntilEnd = async (
  input: NodeJS.ReadableStream,
  signal?: AbortSignal,
): Promise<"aborted" | "ended"> => {
  const state = input as NodeJS.ReadableStream & {
    destroyed?: unknown;
    readableEnded?: unknown;
  };
  if (state.readableEnded === true || state.destroyed === true) return "ended";
  return await new Promise<"aborted" | "ended">((resolve) => {
    let settled = false;
    const discard = (value: unknown): void => {
      if (Buffer.isBuffer(value)) value.fill(0);
    };
    const finish = (result: "aborted" | "ended"): void => {
      if (settled) return;
      settled = true;
      input.off("data", discard);
      input.off("end", onEnded);
      input.off("error", onEnded);
      input.off("close", onEnded);
      signal?.removeEventListener("abort", onAbort);
      input.pause();
      resolve(result);
    };
    const onEnded = (): void => finish("ended");
    const onAbort = (): void => finish("aborted");
    input.on("data", discard);
    input.once("end", onEnded);
    input.once("error", onEnded);
    input.once("close", onEnded);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    if (state.readableEnded === true || state.destroyed === true) {
      onEnded();
      return;
    }
    input.resume();
  });
};

const discardReadableUntilQuiet = (
  input: NodeJS.ReadableStream,
  quietMilliseconds: number,
  maximumMilliseconds: number,
): Promise<"continuous" | "ended" | "quiet"> => new Promise((resolve) => {
  let settled = false;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  const maximumTimer = setTimeout(() => finish("continuous"), maximumMilliseconds);
  const armQuietTimer = (): void => {
    if (quietTimer !== null) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => finish("quiet"), quietMilliseconds);
  };
  const finish = (result: "continuous" | "ended" | "quiet"): void => {
    if (settled) return;
    settled = true;
    if (quietTimer !== null) clearTimeout(quietTimer);
    clearTimeout(maximumTimer);
    input.off("data", onData);
    input.off("end", onEnded);
    input.off("error", onEnded);
    input.off("close", onEnded);
    input.pause();
    resolve(result);
  };
  const onEnded = (): void => finish("ended");
  const onData = (value: unknown): void => {
    if (Buffer.isBuffer(value)) value.fill(0);
    armQuietTimer();
  };
  input.on("data", onData);
  input.once("end", onEnded);
  input.once("error", onEnded);
  input.once("close", onEnded);
  const state = input as NodeJS.ReadableStream & { destroyed?: unknown; readableEnded?: unknown };
  if (state.destroyed === true || state.readableEnded === true) {
    finish("ended");
    return;
  }
  armQuietTimer();
  input.resume();
});

export class ShellTerminalCoordinator {
  readonly #input: NodeJS.ReadableStream;
  readonly #initialRawMode: boolean | null;
  readonly #lifecycleHooks: ShellTerminalLifecycleHooks | null;
  readonly #output: NodeJS.WritableStream;
  readonly #resignal: (signal: ShellLifecycleSignal) => void;
  readonly #terminal: boolean;
  readonly #flushInput: (() => void) | null;
  #active: ActiveQuestion | null = null;
  #bufferedLineCodeUnits = 0;
  #bufferedLines: string[] = [];
  #bufferedLinesOverflowed = false;
  #bufferedPartial: Readonly<{ cursor: number; line: string }> | null = null;
  #bufferedRawBytes = 0;
  #bufferedRawLineBoundaries = 0;
  #bufferedRawChunks: Buffer[] = [];
  #closed = false;
  #dropLeadingLf = false;
  #heldLive = "";
  #heldLiveTruncated = false;
  #inputQuarantineActive = false;
  #outputFailed = false;
  #liveBackpressured = false;
  #liveBackpressureOmitted = false;
  #liveHoldDepth = 0;
  #signalPropagationStarted = false;
  #signalRemovers: (() => void)[] = [];
  readonly #lifecycleController = new AbortController();
  readonly #handleLiveDrain = (): void => {
    this.#liveBackpressured = false;
    const omitted = this.#liveBackpressureOmitted;
    this.#liveBackpressureOmitted = false;
    if (omitted) {
      try {
        this.writeLive(liveBackpressureNotice);
      } catch {
        // writeLive already fenced the input after display authority was lost.
      }
    }
  };
  readonly #handleOutputError = (): void => {
    this.#failDisplayAuthority();
  };
  readonly #handleInputFailure = (): void => {
    this.close();
  };

  constructor(input: ShellTerminalCoordinatorInput) {
    this.#input = input.input;
    const tty = input.input as NodeJS.ReadableStream & {
      isRaw?: unknown;
      setRawMode?: unknown;
    };
    this.#initialRawMode = typeof tty.setRawMode === "function" && typeof tty.isRaw === "boolean"
      ? tty.isRaw
      : null;
    this.#lifecycleHooks = input.lifecycleHooks ?? null;
    this.#output = input.output;
    this.#resignal = input.lifecycleHooks?.resignal ?? ((signal) => {
      if (signal === "SIGQUIT" || signal === "SIGTSTP") input.resignal?.(signal);
    });
    this.#terminal = input.terminal ?? isTerminalStream(input.output);
    this.#flushInput = input.flushInput ?? null;
    if (this.#terminal && this.#flushInput === null) {
      throw new Error("A terminal shell requires an input-flush authority.");
    }
    this.#output.on("error", this.#handleOutputError);
    this.#output.on("close", this.#handleOutputError);
    this.#input.on("error", this.#handleInputFailure);
    this.#input.on("close", this.#handleInputFailure);
    this.#installSignalHooks();
  }

  get lifecycleSignal(): AbortSignal {
    return this.#lifecycleController.signal;
  }

  async question(prompt: string): Promise<string | null> {
    if (this.#closed) return null;
    const outputState = this.#output as NodeJS.WritableStream & { destroyed?: unknown };
    if (outputState.destroyed === true) {
      this.#outputFailed = true;
      this.close();
      return null;
    }
    const inputState = this.#input as NodeJS.ReadableStream & {
      destroyed?: unknown;
      readableEnded?: unknown;
    };
    if (inputState.destroyed === true || inputState.readableEnded === true) {
      this.close();
      return null;
    }
    if (this.#active !== null) {
      throw new Error("A shell terminal question is already active.");
    }
    if (this.#bufferedLinesOverflowed) {
      await this.#quarantineOverflowedInput();
      return null;
    }
    const buffered = this.#bufferedLines.shift();
    if (buffered !== undefined) {
      this.#bufferedLineCodeUnits -= buffered.length;
      return buffered;
    }
    const bufferedRaw = this.#takeBufferedRawInput();
    const dropLeadingLf = bufferedRaw.length === 0 ? this.#dropLeadingLf : false;
    if (bufferedRaw.length > 0) this.#dropLeadingLf = false;
    const controller = new AbortController();
    const activeInputState: {
      interrupted: boolean;
      overflowed: boolean;
      signal: ShellRawSignal | null;
    } = { interrupted: false, overflowed: false, signal: null };
    const boundedInput = createIncrementallyBoundedLineInput(
      bufferedLineCodeUnitLimit,
      () => {
        activeInputState.overflowed = true;
        controller.abort(new Error("Shell input exceeded the bounded line size."));
      },
      this.#input,
      {
        dropLeadingLf,
        onDropLeadingLfChange: (value) => { this.#dropLeadingLf = value; },
        onSignal: (signal) => {
          activeInputState.interrupted = true;
          activeInputState.signal = signal;
          controller.abort(new Error(`Shell input was interrupted by ${signal}.`));
        },
        onTail: (value) => this.#bufferRawInput(value),
      },
    );
    let terminal: Interface;
    try {
      terminal = createInterface({
        input: boundedInput,
        output: this.#output,
        terminal: this.#terminal,
        historySize: 0,
      });
    } catch (error: unknown) {
      boundedInput.destroy();
      for (const chunk of bufferedRaw) chunk.fill(0);
      this.close();
      this.#input.pause();
      (this.#input as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      throw error;
    }
    let preservePartial = true;
    const abortQuestion = (): void => {
      preservePartial = false;
      controller.abort(new Error("Shell input was interrupted."));
    };
    const closeQuestion = (): void => {
      const state = this.#input as NodeJS.ReadableStream & {
        destroyed?: unknown;
        readableEnded?: unknown;
      };
      if (!this.#closed && state.destroyed !== true && state.readableEnded !== true) {
        activeInputState.interrupted = true;
      }
      abortQuestion();
    };
    const interruptQuestion = (): void => {
      activeInputState.interrupted = true;
      abortQuestion();
    };
    const interruptForDisplayFailure = (): void => {
      activeInputState.interrupted = true;
      (terminal as unknown as { output: NodeJS.WritableStream | null }).output = null;
      abortQuestion();
    };
    const active = { controller, interruptForDisplayFailure, prompt, terminal };
    const bufferAdditionalLine = (line: string): void => this.#bufferLine(line);
    terminal.on("line", bufferAdditionalLine);
    terminal.once("SIGINT", interruptQuestion);
    terminal.once("close", closeQuestion);
    this.#active = active;
    let outcome: Readonly<{ kind: "answer"; value: string }> | Readonly<{ kind: "cancelled" }> | null = null;
    let failure: Readonly<{ value: unknown }> | null = null;
    let piped = false;
    let pendingAnswer: Promise<string> | null = null;
    try {
      pendingAnswer = terminal.question(prompt, { signal: controller.signal });
      if (this.#terminal) this.#normalizeInitialPrompt(terminal);
      const partial = this.#bufferedPartial;
      this.#bufferedPartial = null;
      this.#bufferedLineCodeUnits -= partial?.line.length ?? 0;
      if (partial !== null) {
        terminal.write(partial.line);
        let remainingMoves = partial.line.length + 1;
        while (terminal.cursor > partial.cursor && remainingMoves > 0) {
          terminal.write(undefined, { name: "left" });
          remainingMoves -= 1;
        }
        if (terminal.cursor !== partial.cursor) {
          throw new Error("The shell terminal could not restore the buffered input cursor.");
        }
      }
      for (const chunk of bufferedRaw) {
        try {
          boundedInput.write(chunk);
        } finally {
          chunk.fill(0);
        }
      }
      this.#input.pipe(boundedInput);
      piped = true;
      outcome = { kind: "answer", value: await pendingAnswer };
    } catch (error: unknown) {
      if (controller.signal.aborted || isClosedReadlineError(error)) {
        preservePartial = false;
        outcome = { kind: "cancelled" };
      } else {
        preservePartial = false;
        this.#failDisplayAuthority();
        await pendingAnswer?.catch(() => undefined);
        failure = { value: error };
      }
    } finally {
      if (this.#active === active) this.#active = null;
      if (preservePartial && terminal.line.length > 0) {
        this.#bufferPartial(terminal.line, terminal.cursor);
      }
      terminal.off("line", bufferAdditionalLine);
      terminal.off("SIGINT", interruptQuestion);
      terminal.off("close", closeQuestion);
      let terminalCleanupFailure: unknown = null;
      try {
        terminal.close();
      } catch (error: unknown) {
        terminalCleanupFailure = error;
      } finally {
        if (piped) this.#input.unpipe(boundedInput);
        boundedInput.destroy();
        for (const chunk of bufferedRaw) chunk.fill(0);
      }
      if (terminalCleanupFailure !== null) {
        this.close();
        this.#input.pause();
        (this.#input as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
        if (failure === null) failure = { value: terminalCleanupFailure };
      }
    }
    if (activeInputState.signal !== null) {
      await this.#fenceAndResignal(activeInputState.signal);
      return null;
    }
    if (activeInputState.interrupted) {
      await this.#quarantineInterruptedInput();
      if (failure !== null) throw failure.value;
      return null;
    }
    if (failure !== null) throw failure.value;
    if (activeInputState.overflowed) {
      await this.#quarantineOverflowedInput();
      return null;
    }
    return outcome?.kind === "answer" ? outcome.value : null;
  }

  writeLive(value: string): void {
    if (value.length === 0 || this.#closed || this.#inputQuarantineActive || this.#outputFailed) return;
    if (this.#liveHoldDepth > 0) {
      const remaining = heldLiveCodeUnitLimit - this.#heldLive.length;
      if (remaining > 0) this.#heldLive += value.slice(0, remaining);
      if (value.length > remaining) this.#heldLiveTruncated = true;
      return;
    }
    if (this.#liveBackpressured) {
      this.#liveBackpressureOmitted = true;
      return;
    }
    const bounded = boundedLiveWrite(value);
    const active = this.#active;
    if (active === null || !this.#terminal) {
      try {
        const accepted = this.#output.write(bounded);
        if (!accepted) this.#beginLiveBackpressure();
      } catch (error: unknown) {
        this.#failDisplayAuthority();
        throw error;
      }
      return;
    }
    try {
      const terminal = active.terminal;
      const savedLine = terminal.line;
      const savedCursor = terminal.cursor;
      const currentPosition = terminal.getCursorPos();
      cursorTo(this.#output, 0);
      if (currentPosition.rows > 0) {
        moveCursor(this.#output, 0, -currentPosition.rows);
      }
      clearScreenDown(this.#output);
      const accepted = this.#output.write(liveBlock(bounded));
      const outputColumns = (this.#output as NodeJS.WritableStream & { columns?: unknown }).columns;
      const columns = typeof outputColumns === "number" && Number.isSafeInteger(outputColumns) && outputColumns > 0
        ? outputColumns
        : 80;
      const promptPosition = terminalDisplayPosition(active.prompt, columns);
      const expandedLine = expandTerminalTabs(savedLine, promptPosition, columns);
      const redraw = `${active.prompt}${expandedLine.value}`;
      const redrawAccepted = this.#output.write(redraw);
      const exactBoundaryAccepted = redraw.length > 0 && expandedLine.position.cols === 0
        ? this.#output.write(" \b")
        : true;
      const redrawRows = expandedLine.position.rows;
      if (redrawRows !== currentPosition.rows) {
        moveCursor(this.#output, 0, currentPosition.rows - redrawRows);
      }
      cursorTo(this.#output, currentPosition.cols);
      if (terminal.line !== savedLine || terminal.cursor !== savedCursor) {
        throw new Error("The shell terminal could not restore the input cursor.");
      }
      if (
        !accepted
        || !redrawAccepted
        || !exactBoundaryAccepted
        || (this.#output as NodeJS.WritableStream & { writableNeedDrain?: unknown }).writableNeedDrain === true
      ) this.#beginLiveBackpressure();
    } catch (error: unknown) {
      this.#failDisplayAuthority();
      throw error;
    }
  }

  #failDisplayAuthority(): void {
    if (this.#outputFailed) return;
    this.#outputFailed = true;
    const active = this.#active;
    if (active !== null) {
      active.interruptForDisplayFailure();
      return;
    }
    this.close();
    this.#input.pause();
    try {
      (this.#input as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    } catch {
      // A closed coordinator cannot accept more commands even if stream fencing fails.
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#removeSignalHooks();
    this.#lifecycleController.abort(new Error("Shell terminal lifecycle ended."));
    const active = this.#active;
    this.#active = null;
    active?.controller.abort();
    let terminalCleanupFailed = false;
    try {
      active?.terminal.close();
    } catch {
      terminalCleanupFailed = true;
    }
    this.#clearBufferedRawInput();
    this.#bufferedLines = [];
    this.#bufferedLineCodeUnits = 0;
    this.#bufferedLinesOverflowed = false;
    this.#bufferedPartial = null;
    this.#dropLeadingLf = false;
    this.#heldLive = "";
    this.#heldLiveTruncated = false;
    this.#output.off("drain", this.#handleLiveDrain);
    this.#output.off("error", this.#handleOutputError);
    this.#output.off("close", this.#handleOutputError);
    this.#input.off("error", this.#handleInputFailure);
    this.#input.off("close", this.#handleInputFailure);
    this.#liveBackpressured = false;
    this.#liveBackpressureOmitted = false;
    if (terminalCleanupFailed) {
      this.#input.pause();
      (this.#input as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    }
  }

  async establishProtectedInputBoundary(): Promise<number> {
    const discarded = this.discardBufferedInput();
    if (this.#flushInput === null) {
      throw new Error("Protected terminal input requires an input-flush authority.");
    }
    try {
      this.#flushInput();
    } catch {
      this.close();
      await this.#quarantineInput(
        "hra: Protected input cannot prove an empty terminal queue. HRA will discard input until EOF; press Ctrl-D to return safely.\n",
      );
      throw new Error("Protected terminal input could not establish an empty input queue.");
    }
    if (discarded > 0) {
      this.close();
      await this.#quarantineInput(
        "hra: Protected input rejected queued shell input. HRA flushed the current queue and will discard any remaining paste through EOF; press Ctrl-D to exit safely.\n",
      );
    }
    return discarded;
  }

  discardBufferedInput(): number {
    let discarded = this.#bufferedLines.length
      + (this.#bufferedLinesOverflowed ? 1 : 0)
      + (this.#bufferedPartial === null ? 0 : 1)
      + (this.#bufferedRawBytes === 0 ? 0 : Math.max(1, this.#bufferedRawLineBoundaries));
    let dropLeadingLf = this.#bufferedRawBytes === 0 && this.#dropLeadingLf;
    this.#clearBufferedRawInput();
    this.#bufferedLines = [];
    this.#bufferedLineCodeUnits = 0;
    this.#bufferedLinesOverflowed = false;
    this.#bufferedPartial = null;
    const readable = this.#input as unknown as {
      read(size?: number): Buffer | string | null;
    };
    for (;;) {
      const value = readable.read();
      if (value === null) break;
      if (dropLeadingLf && value.length > 0) {
        dropLeadingLf = false;
        const beginsWithLf = Buffer.isBuffer(value)
          ? value[0] === 0x0a
          : value.charCodeAt(0) === 0x0a;
        if (beginsWithLf && value.length === 1) {
          if (Buffer.isBuffer(value)) value.fill(0);
          continue;
        }
      }
      discarded += 1;
      if (Buffer.isBuffer(value)) value.fill(0);
    }
    this.#dropLeadingLf = false;
    return discarded;
  }

  async withLiveOutputHeld<T>(operation: () => Promise<T>): Promise<T> {
    this.#liveHoldDepth += 1;
    try {
      return await operation();
    } finally {
      this.#liveHoldDepth -= 1;
      if (this.#liveHoldDepth === 0) {
        const held = this.#heldLive;
        const truncated = this.#heldLiveTruncated;
        this.#heldLive = "";
        this.#heldLiveTruncated = false;
        if (held.length > 0 || truncated) {
          this.writeLive(`${held}${truncated ? heldLiveTruncationNotice : ""}`);
        }
      }
    }
  }

  discardHeldLiveOutput(): void {
    this.#heldLive = "";
    this.#heldLiveTruncated = false;
  }

  async withSignalHandlingSuspended<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#removeSignalHooks()) {
      this.close();
      this.#fenceInput();
      throw new Error("Shell signal ownership could not be released safely.");
    }
    try {
      return await operation();
    } finally {
      this.#installSignalHooks();
    }
  }

  #bufferRawInput(value: Buffer): void {
    if (value.length === 0) return;
    if (this.#closed || this.#bufferedLinesOverflowed) {
      value.fill(0);
      return;
    }
    let boundaries = 0;
    for (const codeUnit of value) {
      if (codeUnit === 0x0a || codeUnit === 0x0d) boundaries += 1;
    }
    if (
      this.#bufferedLines.length + this.#bufferedRawLineBoundaries + boundaries > bufferedLineLimit
      || this.#bufferedLineCodeUnits + value.length > bufferedLineCodeUnitLimit
    ) {
      this.#bufferedLinesOverflowed = true;
      value.fill(0);
      return;
    }
    this.#bufferedRawChunks.push(value);
    this.#bufferedRawBytes += value.length;
    this.#bufferedRawLineBoundaries += boundaries;
    this.#bufferedLineCodeUnits += value.length;
  }

  #clearBufferedRawInput(): void {
    for (const chunk of this.#bufferedRawChunks) chunk.fill(0);
    this.#bufferedLineCodeUnits -= this.#bufferedRawBytes;
    this.#bufferedRawBytes = 0;
    this.#bufferedRawLineBoundaries = 0;
    this.#bufferedRawChunks = [];
  }

  #takeBufferedRawInput(): readonly Buffer[] {
    const chunks = this.#bufferedRawChunks;
    this.#bufferedLineCodeUnits -= this.#bufferedRawBytes;
    this.#bufferedRawBytes = 0;
    this.#bufferedRawLineBoundaries = 0;
    this.#bufferedRawChunks = [];
    return chunks;
  }

  #bufferLine(line: string): void {
    if (this.#bufferedLinesOverflowed) return;
    if (
      this.#bufferedLines.length >= bufferedLineLimit
      || this.#bufferedLineCodeUnits + line.length > bufferedLineCodeUnitLimit
    ) {
      this.#bufferedLinesOverflowed = true;
      return;
    }
    this.#bufferedLines.push(line);
    this.#bufferedLineCodeUnits += line.length;
  }

  #bufferPartial(partial: string, cursor: number): void {
    if (this.#bufferedLinesOverflowed) return;
    if (this.#bufferedLineCodeUnits + partial.length > bufferedLineCodeUnitLimit) {
      this.#bufferedLinesOverflowed = true;
      return;
    }
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > partial.length) {
      this.#bufferedLinesOverflowed = true;
      return;
    }
    this.#bufferedPartial = { cursor, line: partial };
    this.#bufferedLineCodeUnits += partial.length;
  }

  #beginLiveBackpressure(): void {
    if (this.#liveBackpressured) return;
    this.#liveBackpressured = true;
    this.#output.once("drain", this.#handleLiveDrain);
  }

  async #quarantineInput(notice: string): Promise<void> {
    this.#inputQuarantineActive = true;
    const outputController = new AbortController();
    const outputFailed = (): void => outputController.abort(new Error("Terminal output closed."));
    this.#output.once("error", outputFailed);
    this.#output.once("close", outputFailed);
    try {
      const state = this.#output as NodeJS.WritableStream & { destroyed?: unknown };
      if (!bestEffortWrite(this.#output, notice) || state.destroyed === true) outputFailed();
      if (await discardReadableUntilEnd(this.#input, outputController.signal) === "aborted") {
        this.#outputFailed = true;
        this.#input.pause();
        (this.#input as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      }
    } finally {
      this.#output.off("error", outputFailed);
      this.#output.off("close", outputFailed);
      this.#inputQuarantineActive = false;
    }
  }

  async #quarantineOverflowedInput(): Promise<void> {
    this.discardBufferedInput();
    let flushProved = !this.#terminal;
    if (this.#terminal) {
      try {
        this.#flushInput?.();
        flushProved = true;
      } catch {
        flushProved = false;
      }
    }
    this.close();
    await this.#quarantineInput(
      flushProved
        ? "hra: Shell typeahead exceeded the bounded input queue. HRA flushed the current queue and will discard any remaining paste through EOF; press Ctrl-D to exit the shell safely.\n"
        : "hra: Shell typeahead overflowed and the terminal input queue could not be flushed. HRA will discard input until EOF; press Ctrl-D to return safely.\n",
    );
  }

  async #quarantineInterruptedInput(): Promise<void> {
    this.discardBufferedInput();
    let flushProved = !this.#terminal;
    if (this.#terminal) {
      try {
        this.#flushInput?.();
        flushProved = true;
      } catch {
        flushProved = false;
      }
    }
    this.close();
    await this.#quarantineInput(
      flushProved
        ? "hra: Shell input was interrupted. HRA flushed the current queue and will discard any same-paste tail through EOF; press Ctrl-D to exit safely.\n"
        : "hra: Shell input was interrupted and the terminal queue could not be flushed. HRA will discard input through EOF; press Ctrl-D to exit safely.\n",
    );
  }

  #installSignalHooks(): void {
    const inputState = this.#input as NodeJS.ReadableStream & {
      destroyed?: unknown;
      readableEnded?: unknown;
    };
    if (inputState.destroyed === true || inputState.readableEnded === true) {
      this.close();
      return;
    }
    if (
      this.#closed
      || this.#lifecycleHooks === null
      || this.#signalRemovers.length > 0
      || this.#signalPropagationStarted
    ) return;
    const installed: (() => void)[] = [];
    try {
      for (const signal of shellLifecycleSignals) {
        installed.push(this.#lifecycleHooks.onSignal(signal, () => this.#handleLifecycleSignal(signal)));
      }
      this.#signalRemovers = installed;
    } catch (error: unknown) {
      this.#signalRemovers = installed;
      this.#removeSignalHooks();
      this.close();
      this.#fenceInput();
      throw error;
    }
  }

  #removeSignalHooks(): boolean {
    const removers = this.#signalRemovers;
    this.#signalRemovers = [];
    const failed: (() => void)[] = [];
    for (const remove of removers.reverse()) {
      try {
        remove();
      } catch {
        failed.push(remove);
      }
    }
    this.#signalRemovers = failed;
    return failed.length === 0;
  }

  #setRawModeProved(mode: boolean): boolean {
    if (this.#initialRawMode === null) return false;
    const tty = this.#input as NodeJS.ReadableStream & {
      isRaw?: unknown;
      setRawMode?: (mode: boolean) => unknown;
    };
    if (tty.isRaw === mode) return true;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        tty.setRawMode?.(mode);
      } catch {
        if (tty.isRaw === mode) return true;
        continue;
      }
      if (tty.isRaw === mode) return true;
    }
    return false;
  }

  #fenceInput(): void {
    this.#input.pause();
    try {
      (this.#input as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    } catch {
      // A closed coordinator cannot dispatch input after a failed stream fence.
    }
  }

  #handleLifecycleSignal(signal: ShellLifecycleSignal): void {
    if (this.#signalPropagationStarted) return;
    this.#signalPropagationStarted = true;
    this.#removeSignalHooks();
    this.close();
    const hooksRemoved = this.#removeSignalHooks();
    this.discardBufferedInput();
    if (this.#terminal) {
      try {
        this.#flushInput?.();
      } catch {
        // The input source is synchronously fenced below when a flush is unavailable.
      }
    }
    if (this.#initialRawMode !== null) this.#setRawModeProved(this.#initialRawMode);
    this.#fenceInput();
    if (!hooksRemoved) return;
    try {
      this.#resignal(signal);
    } catch {
      // Readline and raw input have already been restored or fenced.
    }
  }

  #hasSignalPropagationStarted(): boolean {
    return this.#signalPropagationStarted;
  }

  async #fenceAndResignal(signal: ShellRawSignal): Promise<void> {
    if (this.#signalPropagationStarted) return;
    this.discardBufferedInput();
    const rawCustodyProved = this.#setRawModeProved(true);
    let boundaryProved = false;
    if (rawCustodyProved) {
      const tail = await discardReadableUntilQuiet(
        this.#input,
        rawSignalTailQuietMilliseconds,
        rawSignalTailMaximumMilliseconds,
      );
      if (!this.#hasSignalPropagationStarted() && tail !== "continuous") {
        this.discardBufferedInput();
        try {
          if (this.#flushInput === null) throw new Error("Terminal input flush authority is unavailable.");
          this.#flushInput();
          this.discardBufferedInput();
          boundaryProved = true;
        } catch {
          boundaryProved = false;
        }
      }
    }
    if (this.#hasSignalPropagationStarted()) return;
    if (this.#initialRawMode !== null) this.#setRawModeProved(this.#initialRawMode);
    this.close();
    const hooksRemoved = this.#removeSignalHooks();
    this.#fenceInput();
    if (!boundaryProved || !hooksRemoved) return;
    this.#signalPropagationStarted = true;
    try {
      this.#resignal(signal);
    } catch {
      // Raw mode has already been restored and the input source has been fenced.
    }
  }

  #normalizeInitialPrompt(terminal: Interface): void {
    const initialPosition = terminal.getCursorPos();
    terminal.write(undefined, { ctrl: true, name: "e" });
    terminal.write(" ");
    terminal.write(undefined, { ctrl: true, name: "u" });
    const redrawnPosition = terminal.getCursorPos();
    cursorTo(this.#output, 0);
    const rowsFromInitialOrigin = initialPosition.rows + redrawnPosition.rows;
    if (rowsFromInitialOrigin > 0) moveCursor(this.#output, 0, -rowsFromInitialOrigin);
    clearScreenDown(this.#output);
    terminal.prompt();
  }
}
