import { describe, expect, test } from "bun:test";
import { createInterface } from "node:readline/promises";
import { PassThrough, Writable } from "node:stream";

import { ShellTerminalCoordinator } from "./shell-terminal";

const leftArrow = "\u001b[D";

const settleStreams = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

class CapturingTty extends Writable {
  readonly isTTY = true;
  readonly rows = 24;
  readonly columns: number;
  value = "";

  constructor(columns: number) {
    super();
    this.columns = columns;
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.value += chunk.toString("utf8");
    callback();
  }
}

class BlockingOutput extends Writable {
  value = "";
  #release: (() => void) | null = null;

  constructor() {
    super({ highWaterMark: 1 });
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.value += chunk.toString("utf8");
    this.#release = callback;
  }

  release(): void {
    const release = this.#release;
    this.#release = null;
    release?.();
  }
}

class AsyncFailingTty extends CapturingTty {
  fail = false;

  override _write(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.fail) {
      callback(new Error("tty EIO"));
      return;
    }
    super._write(chunk, encoding, callback);
  }
}

class VirtualTerminal {
  readonly #columns: number;
  readonly #cells: string[][] = [[]];
  #row = 0;
  #column = 0;

  constructor(columns: number) {
    this.#columns = columns;
  }

  accept(source: string): void {
    let offset = 0;
    while (offset < source.length) {
      if (source[offset] === "\u001b" && source[offset + 1] === "[") {
        const match = /^([0-9;?]*)([A-Za-z])/u.exec(source.slice(offset + 2));
        if (match === null) throw new Error("Virtual terminal received an incomplete escape sequence.");
        this.#applyControl(match[1] ?? "", match[2] ?? "");
        offset += match[0].length + 2;
        continue;
      }
      const scalar = source[offset];
      if (scalar === "\r") {
        this.#column = 0;
      } else if (scalar === "\n") {
        this.#row += 1;
        this.#column = 0;
        this.#ensureRow(this.#row);
      } else if (scalar === "\b") {
        this.#column = Math.max(0, this.#column - 1);
      } else if (scalar !== undefined) {
        this.#ensureRow(this.#row);
        this.#cells[this.#row]![this.#column] = scalar;
        this.#column += 1;
        if (this.#column === this.#columns) {
          this.#row += 1;
          this.#column = 0;
          this.#ensureRow(this.#row);
        }
      }
      offset += 1;
    }
  }

  cursor(): Readonly<{ column: number; row: number }> {
    return { column: this.#column, row: this.#row };
  }

  lines(): readonly string[] {
    const rendered = this.#cells.map((row) => {
      let value = "";
      for (let column = 0; column < row.length; column += 1) {
        value += row[column] ?? " ";
      }
      return value.trimEnd();
    });
    while (rendered.at(-1) === "") rendered.pop();
    return rendered;
  }

  #applyControl(parameters: string, command: string): void {
    const first = parameters.split(";")[0];
    const amount = first === undefined || first === "" ? 1 : Number(first);
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new Error(`Virtual terminal received invalid CSI parameters: ${parameters}`);
    }
    switch (command) {
      case "A": this.#row = Math.max(0, this.#row - amount); return;
      case "B": this.#row += amount; this.#ensureRow(this.#row); return;
      case "C": this.#column = Math.min(this.#columns - 1, this.#column + amount); return;
      case "D": this.#column = Math.max(0, this.#column - amount); return;
      case "G": this.#column = Math.max(0, Math.min(this.#columns - 1, amount - 1)); return;
      case "J": {
        if (amount !== 0) throw new Error(`Virtual terminal cannot model CSI ${parameters}J.`);
        this.#ensureRow(this.#row);
        this.#cells[this.#row]!.length = this.#column;
        this.#cells.length = this.#row + 1;
        return;
      }
      default: throw new Error(`Virtual terminal received unsupported CSI command: ${command}`);
    }
  }

  #ensureRow(row: number): void {
    while (this.#cells.length <= row) this.#cells.push([]);
  }
}

const terminalFixture = (columns: number): Readonly<{
  coordinator: ShellTerminalCoordinator;
  input: PassThrough;
  output: CapturingTty;
}> => {
  const input = new PassThrough();
  const output = new CapturingTty(columns);
  return {
    coordinator: new ShellTerminalCoordinator({ flushInput: () => undefined, input, output }),
    input,
    output,
  };
};

const screenFor = (output: CapturingTty): VirtualTerminal => {
  const screen = new VirtualTerminal(output.columns);
  screen.accept(output.value);
  return screen;
};

describe("persistent shell terminal coordination", () => {
  test("quarantines an ordinary Ctrl-C and its same-chunk command tail", async () => {
    const fixture = terminalFixture(40);
    const interrupted = fixture.coordinator.question("ordinary> ");
    await settleStreams();
    fixture.input.write(Buffer.from("must-not-replay\u0003danger\n"));
    await settleStreams();
    expect(fixture.output.value).toContain("same-paste tail through EOF");
    fixture.input.write("also-must-not-run\n");
    fixture.input.end();
    expect(await interrupted).toBeNull();
    expect(fixture.input.read()).toBeNull();
    expect(await fixture.coordinator.question("next> ")).toBeNull();
    fixture.coordinator.close();
  });

  test("quarantines a delayed parent-shell tail after ordinary Ctrl-D", async () => {
    const fixture = terminalFixture(40);
    const interrupted = fixture.coordinator.question("ordinary> ");
    await settleStreams();
    fixture.input.write(Buffer.from([0x04]));
    await settleStreams();
    expect(fixture.output.value).toContain("same-paste tail through EOF");
    fixture.input.write("danger\n");
    fixture.input.end();
    expect(await interrupted).toBeNull();
    expect(fixture.input.read()).toBeNull();
    expect(await fixture.coordinator.question("next> ")).toBeNull();
    fixture.coordinator.close();
  });

  test("settles an ordinary question when terminal input reaches EOF", async () => {
    const fixture = terminalFixture(40);
    const answer = fixture.coordinator.question("ordinary> ");
    await settleStreams();
    fixture.input.end();
    expect(await answer).toBeNull();
    fixture.coordinator.close();
  });

  test("settles ordinary input on source error and close without end", async () => {
    for (const failure of ["error", "close"] as const) {
      const input = new PassThrough();
      const output = new CapturingTty(40);
      const coordinator = new ShellTerminalCoordinator({ flushInput: () => undefined, input, output });
      const answer = coordinator.question("ordinary> ");
      await settleStreams();
      if (failure === "error") input.destroy(new Error("tty EIO"));
      else input.destroy();
      expect(await answer).toBeNull();
      coordinator.close();
    }
  });

  test("closes before the next question when input fails between prompts", async () => {
    for (const failure of ["error", "close"] as const) {
      const input = new PassThrough();
      const output = new CapturingTty(40);
      const coordinator = new ShellTerminalCoordinator({ flushInput: () => undefined, input, output });
      const first = coordinator.question("first> ");
      input.write("safe\n");
      expect(await first).toBe("safe");
      if (failure === "error") input.destroy(new Error("tty EIO"));
      else input.destroy();
      await settleStreams();
      expect(await coordinator.question("must-not-open> ")).toBeNull();
      coordinator.close();
    }
  });

  test("closes active input when a terminal write fails asynchronously", async () => {
    const input = new PassThrough();
    const output = new AsyncFailingTty(40);
    const coordinator = new ShellTerminalCoordinator({ flushInput: () => undefined, input, output });
    const answer = coordinator.question("ordinary> ");
    await settleStreams();
    input.write("draft");
    await settleStreams();
    output.fail = true;
    coordinator.writeLive("LIVE");
    await settleStreams();
    expect(await answer).toBeNull();
    expect(await coordinator.question("closed> ")).toBeNull();
    coordinator.close();
  });

  test("closes active and future prompts when terminal output closes cleanly", async () => {
    for (const phase of ["active", "between"] as const) {
      const input = new PassThrough();
      const output = new CapturingTty(40);
      const coordinator = new ShellTerminalCoordinator({ flushInput: () => undefined, input, output });
      const first = coordinator.question("first> ");
      if (phase === "between") {
        input.write("safe\n");
        expect(await first).toBe("safe");
      }
      output.destroy();
      await settleStreams();
      if (phase === "active") expect(await first).toBeNull();
      expect(await coordinator.question("must-not-open> ")).toBeNull();
      coordinator.close();
    }
  });

  test("redraws wrapped partial input and preserves a middle cursor exactly", async () => {
    const fixture = terminalFixture(7);
    const answer = fixture.coordinator.question("hra> ");
    await settleStreams();
    fixture.input.write("abcdefghijkl");
    await settleStreams();
    fixture.input.write(leftArrow.repeat(3));
    await settleStreams();

    fixture.coordinator.writeLive("LIVE");
    const screen = screenFor(fixture.output);
    expect(screen.lines()).toEqual(["LIVE", "hra> ab", "cdefghi", "jkl"]);
    expect(screen.cursor()).toEqual({ column: 0, row: 3 });

    fixture.input.write("X\n");
    expect(await answer).toBe("abcdefghiXjkl");
    fixture.coordinator.close();
  });

  test("removes a wrapped empty prompt before drawing a live block", async () => {
    const fixture = terminalFixture(7);
    const answer = fixture.coordinator.question("very-long> ");
    await settleStreams();

    fixture.coordinator.writeLive("NOTICE");
    const screen = screenFor(fixture.output);
    expect(screen.lines()).toEqual(["NOTICE", "very-lo", "ng>"]);
    expect(screen.cursor()).toEqual({ column: 4, row: 2 });

    fixture.input.write("\n");
    expect(await answer).toBe("");
    fixture.coordinator.close();
  });

  test("normalizes delayed terminal autowrap at an exact redraw boundary", async () => {
    const fixture = terminalFixture(7);
    const answer = fixture.coordinator.question("hra> ");
    await settleStreams();
    fixture.input.write("ab");
    await settleStreams();
    fixture.coordinator.writeLive("LIVE");
    const screen = screenFor(fixture.output);
    expect(screen.lines()).toEqual(["LIVE", "hra> ab"]);
    expect(screen.cursor()).toEqual({ column: 0, row: 2 });
    expect(fixture.output.value).toContain("hra> ab \b");
    fixture.input.write("!\n");
    expect(await answer).toBe("ab!");
    fixture.coordinator.close();
  });

  test("fences input when initial prompt normalization loses display authority", async () => {
    const fixture = terminalFixture(40);
    const originalWrite = fixture.output.write.bind(fixture.output);
    let failNormalization = true;
    fixture.output.write = ((chunk: unknown, ...arguments_: unknown[]) => {
      const value = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (failNormalization && value === " ") {
        failNormalization = false;
        throw new Error("normalize fail");
      }
      return originalWrite(chunk as never, ...(arguments_ as never[]));
    }) as typeof fixture.output.write;

    const first = fixture.coordinator.question("p> ");
    await settleStreams();
    fixture.input.write("danger\n");
    fixture.input.end();
    await expect(first).rejects.toThrow("normalize fail");
    expect(fixture.input.read()).toBeNull();
    expect(await fixture.coordinator.question("next> ")).toBeNull();
    fixture.coordinator.close();
  });

  test("expands a pasted tab with readline-compatible terminal stops", async () => {
    const fixture = terminalFixture(6);
    const answer = fixture.coordinator.question("p> ");
    await settleStreams();
    fixture.input.write("\u001b[200~a\tb\u001b[201~");
    await settleStreams();
    const beforeLive = fixture.output.value.length;
    fixture.coordinator.writeLive("LIVE");
    const liveRedraw = fixture.output.value.slice(beforeLive);
    expect(liveRedraw).toContain("p> a    b");
    expect(liveRedraw).not.toContain("\t");
    fixture.input.write("!\n");
    expect(await answer).toBe("a\tb!");
    fixture.coordinator.close();
  });

  test("moves from physical grapheme width to readline's logical ZWJ cursor row", async () => {
    const fixture = terminalFixture(6);
    const family = "👨‍👩‍👧‍👦";
    const answer = fixture.coordinator.question("p> ");
    await settleStreams();
    fixture.input.write(`\u001b[200~${family}\u001b[201~`);
    await settleStreams();
    const beforeLive = fixture.output.value.length;
    fixture.coordinator.writeLive("LIVE");
    const redraw = fixture.output.value.slice(beforeLive);
    expect(redraw).toContain(`p> ${family}`);
    expect(redraw).toContain("\u001b[2B");
    fixture.input.write("!\n");
    expect(await answer).toBe(`${family}!`);
    fixture.coordinator.close();
  });

  test("pre-wraps repeated wide graphemes that begin at the terminal margin", async () => {
    const fixture = terminalFixture(5);
    const emoji = "😀".repeat(5);
    const answer = fixture.coordinator.question("1234");
    await settleStreams();
    fixture.input.write(`\u001b[200~${emoji}\u001b[201~`);
    await settleStreams();
    const beforeLive = fixture.output.value.length;
    fixture.coordinator.writeLive("LIVE");
    const redraw = fixture.output.value.slice(beforeLive);
    expect(redraw).toContain(`1234${emoji}`);
    expect(redraw).not.toContain("\u001b[1B");
    fixture.input.write("!\n");
    expect(await answer).toBe(`${emoji}!`);
    fixture.coordinator.close();
  });

  test("keeps each repeated update and only one active prompt", async () => {
    const fixture = terminalFixture(10);
    const answer = fixture.coordinator.question("hra> ");
    await settleStreams();
    fixture.input.write("draft");
    await settleStreams();

    fixture.coordinator.writeLive("first");
    fixture.coordinator.writeLive("second\n");
    const screen = screenFor(fixture.output);
    expect(screen.lines()).toEqual(["first", "second", "hra> draft"]);
    expect(screen.lines().join("\n").match(/hra> /gu)).toHaveLength(1);

    fixture.input.write("!\n");
    expect(await answer).toBe("draft!");
    fixture.coordinator.close();
  });

  test("fences the active draft when any live redraw stage fails synchronously", async () => {
    for (const stage of ["cursor", "live", "prompt"] as const) {
      const fixture = terminalFixture(40);
      const answer = fixture.coordinator.question("hra> ");
      await settleStreams();
      fixture.input.write("draft");
      await settleStreams();
      const originalWrite = fixture.output.write.bind(fixture.output);
      let fail = true;
      fixture.output.write = ((chunk: unknown, ...arguments_: unknown[]) => {
        const value = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        const targeted = stage === "cursor"
          ? value.includes("\u001b[1G")
          : stage === "live"
            ? value === "LIVE\n"
            : value === "hra> draft";
        if (fail && targeted) {
          fail = false;
          throw new Error(`${stage} redraw unavailable`);
        }
        return originalWrite(chunk as never, ...(arguments_ as never[]));
      }) as typeof fixture.output.write;
      expect(() => fixture.coordinator.writeLive("LIVE")).toThrow(`${stage} redraw unavailable`);
      fixture.input.write("!\n");
      fixture.input.end();
      expect(await answer).toBeNull();
      expect(fixture.input.read()).toBeNull();
      expect(await fixture.coordinator.question("next> ")).toBeNull();
      fixture.coordinator.close();
    }
  });

  test("preserves additional pasted command lines from the same input chunk", async () => {
    const fixture = terminalFixture(40);
    const first = fixture.coordinator.question("first> ");
    await settleStreams();
    fixture.input.write("one\ntwo\nthree\n");
    expect(await first).toBe("one");
    expect(await fixture.coordinator.question("second> ")).toBe("two");
    expect(await fixture.coordinator.question("third> ")).toBe("three");
    fixture.coordinator.close();
  });

  test("exits without reopening input after the bounded paste queue overflows", async () => {
    const input = new PassThrough();
    const output = new CapturingTty(80);
    let kernelFlushes = 0;
    const coordinator = new ShellTerminalCoordinator({
      flushInput: () => {
        kernelFlushes += 1;
        input.write("dangerous-parent-command\n");
      },
      input,
      output,
    });
    const first = coordinator.question("first> ");
    await settleStreams();
    const overflow = Array.from({ length: 258 }, (_, index) => `command-${String(index)}`);
    input.write(`${overflow.join("\n")}\n`);
    expect(await first).toBe("command-0");

    const overflowExit = coordinator.question("must-not-open> ");
    await settleStreams();
    expect(kernelFlushes).toBe(1);
    expect(output.value).toContain("discard any remaining paste through EOF");
    coordinator.writeLive("LIVE DURING OVERFLOW QUARANTINE");
    expect(output.value).not.toContain("LIVE DURING OVERFLOW QUARANTINE");
    input.write("must-not-run\n");
    input.end();
    expect(await overflowExit).toBeNull();
    expect(input.read()).toBeNull();
    expect(await coordinator.question("still-closed> ")).toBeNull();
    coordinator.close();
  });

  test("bounds an active no-newline shell line and quarantines its tail", async () => {
    const fixture = terminalFixture(80);
    const answer = fixture.coordinator.question("bounded> ");
    await settleStreams();
    fixture.input.write("x".repeat(256 * 1_024 + 1));
    await settleStreams();
    expect(fixture.output.value).toContain("bounded input queue");
    fixture.input.write("must-not-reach-parent\n");
    fixture.coordinator.writeLive("LIVE DURING ACTIVE-LINE QUARANTINE");
    expect(fixture.output.value).not.toContain("LIVE DURING ACTIVE-LINE QUARANTINE");
    fixture.input.end();
    expect(await answer).toBeNull();
    expect(fixture.input.read()).toBeNull();
    expect(await fixture.coordinator.question("closed> ")).toBeNull();
    fixture.coordinator.close();
  });

  test("preserves the source TTY raw-mode lifecycle through bounded input", async () => {
    const input = new PassThrough() as PassThrough & {
      isRaw: boolean;
      isTTY: true;
      setRawMode(mode: boolean): PassThrough;
    };
    const rawModes: boolean[] = [];
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (mode: boolean) => {
      rawModes.push(mode);
      input.isRaw = mode;
      return input;
    };
    const output = new CapturingTty(80);
    const coordinator = new ShellTerminalCoordinator({ flushInput: () => undefined, input, output });
    const answer = coordinator.question("raw> ");
    input.write("safe\n");
    expect(await answer).toBe("safe");
    expect(rawModes).toEqual([true, false]);
    coordinator.close();
  });

  test("holds raw custody through delayed signal tails before propagating Ctrl-backslash and Ctrl-Z", async () => {
    for (const [byte, signal] of [[0x1c, "SIGQUIT"], [0x1a, "SIGTSTP"]] as const) {
      const input = new PassThrough() as PassThrough & {
        isRaw: boolean;
        isTTY: true;
        setRawMode(mode: boolean): PassThrough;
      };
      const rawModes: boolean[] = [];
      input.isTTY = true;
      input.isRaw = false;
      input.setRawMode = (mode: boolean) => {
        rawModes.push(mode);
        input.isRaw = mode;
        return input;
      };
      const output = new CapturingTty(80);
      const signalListeners = new Map<string, () => void>();
      const resignalled: string[] = [];
      const propagationStates: Array<Readonly<{
        destroyed: boolean;
        listenerCount: number;
        raw: boolean;
      }>> = [];
      let flushes = 0;
      const coordinator = new ShellTerminalCoordinator({
        flushInput: () => { flushes += 1; },
        input,
        lifecycleHooks: {
          onSignal: (received, listener) => {
            signalListeners.set(received, listener);
            return () => { signalListeners.delete(received); };
          },
          resignal: (received) => {
            propagationStates.push({
              destroyed: input.destroyed,
              listenerCount: signalListeners.size,
              raw: input.isRaw,
            });
            resignalled.push(received);
          },
        },
        output,
      });
      const answer = coordinator.question("raw> ");
      await settleStreams();
      input.write(Buffer.from([byte, 0x78]));
      let delayedTailArrivedWhileRaw = false;
      setTimeout(() => {
        delayedTailArrivedWhileRaw = input.isRaw;
        input.write("must-not-reach-parent\n");
      }, 30);

      expect(await answer).toBeNull();
      expect(delayedTailArrivedWhileRaw).toBe(true);
      expect(flushes).toBe(1);
      expect(rawModes).toEqual([true, false, true, false]);
      expect(input.isRaw).toBe(false);
      expect(input.destroyed).toBe(true);
      expect(input.read()).toBeNull();
      expect(resignalled).toEqual([signal]);
      expect(propagationStates).toEqual([{ destroyed: true, listenerCount: 0, raw: false }]);
      expect(await coordinator.question("must-not-open> ")).toBeNull();
      coordinator.close();
    }
  });

  test("synchronously restores or fences ordinary input before propagating external signals", async () => {
    const signals = process.platform === "win32"
      ? ["SIGINT", "SIGTERM"] as const
      : ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGTSTP"] as const;
    for (const phase of ["active", "between"] as const) {
      for (const signal of signals) {
        const input = new PassThrough() as PassThrough & {
          isRaw: boolean;
          isTTY: true;
          setRawMode(mode: boolean): PassThrough;
        };
        const rawModes: boolean[] = [];
        input.isTTY = true;
        input.isRaw = false;
        input.setRawMode = (mode: boolean) => {
          rawModes.push(mode);
          input.isRaw = mode;
          return input;
        };
        const listeners = new Map<string, () => void>();
        const propagated: Array<Readonly<{
          destroyed: boolean;
          flushes: number;
          listenerCount: number;
          raw: boolean;
          signal: string;
        }>> = [];
        let flushes = 0;
        const coordinator = new ShellTerminalCoordinator({
          flushInput: () => { flushes += 1; },
          input,
          lifecycleHooks: {
            onSignal: (received, listener) => {
              listeners.set(received, listener);
              return () => { listeners.delete(received); };
            },
            resignal: (received) => {
              propagated.push({
                destroyed: input.destroyed,
                flushes,
                listenerCount: listeners.size,
                raw: input.isRaw,
                signal: received,
              });
            },
          },
          output: new CapturingTty(80),
        });
        let activeAnswer: Promise<string | null> | null = null;
        if (phase === "active") {
          activeAnswer = coordinator.question("active> ");
          await settleStreams();
          expect(input.isRaw).toBe(true);
        } else {
          const first = coordinator.question("first> ");
          input.write("safe\n");
          expect(await first).toBe("safe");
          expect(input.isRaw).toBe(false);
        }
        const listener = listeners.get(signal);
        expect(listener).toBeDefined();
        listener?.();
        expect(propagated).toEqual([{
          destroyed: true,
          flushes: 1,
          listenerCount: 0,
          raw: false,
          signal,
        }]);
        expect(listeners.size).toBe(0);
        expect(input.read()).toBeNull();
        if (activeAnswer !== null) expect(await activeAnswer).toBeNull();
        expect(await coordinator.question("must-not-open> ")).toBeNull();
        coordinator.close();
        expect(rawModes).toEqual([true, false]);
      }
    }
  });

  test("hands signal ownership off without leaking or duplicating lifecycle listeners", async () => {
    const input = new PassThrough();
    const listeners = new Map<string, () => void>();
    const coordinator = new ShellTerminalCoordinator({
      flushInput: () => undefined,
      input,
      lifecycleHooks: {
        onSignal: (signal, listener) => {
          expect(listeners.has(signal)).toBe(false);
          listeners.set(signal, listener);
          return () => { listeners.delete(signal); };
        },
        resignal: () => undefined,
      },
      output: new CapturingTty(80),
    });
    const expectedListeners = process.platform === "win32" ? 2 : 5;
    expect(listeners.size).toBe(expectedListeners);
    await coordinator.withSignalHandlingSuspended(async () => {
      expect(listeners.size).toBe(0);
    });
    expect(listeners.size).toBe(expectedListeners);
    coordinator.close();
    expect(listeners.size).toBe(0);
  });

  test("delegates only foreground interrupt ownership while retaining process lifecycle hooks", async () => {
    const input = new PassThrough();
    const listeners = new Map<string, () => void>();
    const coordinator = new ShellTerminalCoordinator({
      flushInput: () => undefined,
      input,
      lifecycleHooks: {
        onSignal: (signal, listener) => {
          expect(listeners.has(signal)).toBe(false);
          listeners.set(signal, listener);
          return () => { listeners.delete(signal); };
        },
        resignal: () => undefined,
      },
      output: new CapturingTty(80),
    });
    const expectedListeners = process.platform === "win32" ? 2 : 5;
    await coordinator.withInterruptHandlingSuspended(async () => {
      expect(listeners.has("SIGINT")).toBe(false);
      expect(listeners.has("SIGTERM")).toBe(true);
      expect(listeners.size).toBe(expectedListeners - 1);
    });
    expect(listeners.has("SIGINT")).toBe(true);
    expect(listeners.size).toBe(expectedListeners);
    coordinator.close();
    expect(listeners.size).toBe(0);
  });

  test("does not propagate a raw signal when the final terminal flush cannot be proved", async () => {
    const input = new PassThrough() as PassThrough & {
      isRaw: boolean;
      isTTY: true;
      setRawMode(mode: boolean): PassThrough;
    };
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (mode: boolean) => {
      input.isRaw = mode;
      return input;
    };
    const resignalled: string[] = [];
    const coordinator = new ShellTerminalCoordinator({
      flushInput: () => { throw new Error("flush unavailable"); },
      input,
      output: new CapturingTty(80),
      resignal: (signal) => { resignalled.push(signal); },
    });
    const answer = coordinator.question("raw> ");
    await settleStreams();
    input.write("\u001c");
    expect(await answer).toBeNull();
    expect(resignalled).toEqual([]);
    expect(input.isRaw).toBe(false);
    expect(input.destroyed).toBe(true);
    coordinator.close();
  });

  test("fences the shell when ordinary readline cannot restore raw mode", async () => {
    const input = new PassThrough() as PassThrough & {
      isRaw: boolean;
      isTTY: true;
      setRawMode(mode: boolean): PassThrough;
    };
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (mode: boolean) => {
      if (!mode) throw new Error("restore failed");
      input.isRaw = true;
      return input;
    };
    const output = new CapturingTty(80);
    const coordinator = new ShellTerminalCoordinator({ flushInput: () => undefined, input, output });
    const answer = coordinator.question("raw> ");
    input.write("ok\n");
    await expect(answer).rejects.toThrow("restore failed");
    expect(input.destroyed).toBe(true);
    expect(await coordinator.question("must-not-open> ")).toBeNull();
    coordinator.close();
  });

  test("retries one transient ordinary raw-mode restoration failure", async () => {
    const input = new PassThrough() as PassThrough & {
      isRaw: boolean;
      isTTY: true;
      setRawMode(mode: boolean): PassThrough;
    };
    let falseCalls = 0;
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (mode: boolean) => {
      if (!mode) {
        falseCalls += 1;
        if (falseCalls === 1) throw new Error("transient restore failure");
      }
      input.isRaw = mode;
      return input;
    };
    const output = new CapturingTty(80);
    const coordinator = new ShellTerminalCoordinator({ flushInput: () => undefined, input, output });
    const answer = coordinator.question("raw> ");
    input.write("ok\n");
    expect(await answer).toBe("ok");
    expect(falseCalls).toBe(2);
    expect(input.isRaw).toBe(false);
    expect(input.destroyed).toBe(false);
    coordinator.close();
  });

  test("fences ordinary input when raw activation is a silent no-op", async () => {
    const input = new PassThrough() as PassThrough & {
      isRaw: boolean;
      isTTY: true;
      setRawMode(mode: boolean): PassThrough;
    };
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = () => input;
    const output = new CapturingTty(80);
    const coordinator = new ShellTerminalCoordinator({ flushInput: () => undefined, input, output });
    await expect(coordinator.question("raw> ")).rejects.toThrow("requested raw mode");
    expect(input.destroyed).toBe(true);
    expect(await coordinator.question("must-not-open> ")).toBeNull();
    coordinator.close();
  });

  test("preserves a trailing partial pasted line across question interfaces", async () => {
    const fixture = terminalFixture(40);
    const first = fixture.coordinator.question("first> ");
    await settleStreams();
    fixture.input.write("one\ntw");
    expect(await first).toBe("one");

    const second = fixture.coordinator.question("second> ");
    fixture.input.write("o\n");
    expect(await second).toBe("two");
    fixture.coordinator.close();
  });

  test("preserves the edit cursor of a trailing partial pasted line", async () => {
    const fixture = terminalFixture(40);
    const first = fixture.coordinator.question("first> ");
    await settleStreams();
    fixture.input.write(`one\nabcd${leftArrow.repeat(2)}`);
    await settleStreams();
    expect(await first).toBe("one");

    const second = fixture.coordinator.question("second> ");
    fixture.input.write("X\n");
    expect(await second).toBe("abXcd");
    fixture.coordinator.close();
  });

  test("preserves a split UTF-8 scalar after an answered line", async () => {
    const fixture = terminalFixture(40);
    const scalar = Buffer.from("😀", "utf8");
    const first = fixture.coordinator.question("first> ");
    await settleStreams();
    fixture.input.write(Buffer.concat([Buffer.from("one\n"), scalar.subarray(0, 2)]));
    expect(await first).toBe("one");

    const second = fixture.coordinator.question("second> ");
    fixture.input.write(Buffer.concat([scalar.subarray(2), Buffer.from("\n")]));
    expect(await second).toBe("😀");
    fixture.coordinator.close();
  });

  test("coalesces a CRLF pair split across question generations", async () => {
    const fixture = terminalFixture(40);
    const first = fixture.coordinator.question("first> ");
    await settleStreams();
    fixture.input.write("one\r");
    expect(await first).toBe("one");

    const second = fixture.coordinator.question("second> ");
    fixture.input.write("\ntwo\n");
    expect(await second).toBe("two");
    fixture.coordinator.close();
  });

  test("does not classify the delayed LF of an ordinary CRLF as protected typeahead", async () => {
    const fixture = terminalFixture(40);
    const first = fixture.coordinator.question("first> ");
    await settleStreams();
    fixture.input.write("one\r");
    expect(await first).toBe("one");

    fixture.input.write("\n");
    expect(await fixture.coordinator.establishProtectedInputBoundary()).toBe(0);
    fixture.coordinator.close();
  });

  test("preserves a split terminal key sequence after an answered line", async () => {
    const fixture = terminalFixture(40);
    const first = fixture.coordinator.question("first> ");
    await settleStreams();
    fixture.input.write(Buffer.from("one\rab\u001b["));
    expect(await first).toBe("one");

    const second = fixture.coordinator.question("second> ");
    fixture.input.write("DX\r");
    expect(await second).toBe("aXb");
    fixture.coordinator.close();
  });

  test("quarantines a delayed paste tail after rejecting protected typeahead", async () => {
    const input = new PassThrough();
    const output = new CapturingTty(40);
    const coordinator = new ShellTerminalCoordinator({
      flushInput: () => {
        setImmediate(() => input.write("SECRET_TAIL\n"));
      },
      input,
      output,
    });
    const first = coordinator.question("ordinary> ");
    await settleStreams();
    input.write("command\npretyped-secret-or-command\n");
    expect(await first).toBe("command");
    const boundary = coordinator.establishProtectedInputBoundary();
    await settleStreams();
    input.end();
    expect(await boundary).toBe(1);

    expect(output.value).toContain("discard any remaining paste through EOF");
    expect(await coordinator.question("next> ")).toBeNull();
    coordinator.close();
  });

  test("quarantines terminal input through EOF when a protected-boundary flush fails", async () => {
    const input = new PassThrough();
    const output = new CapturingTty(80);
    const coordinator = new ShellTerminalCoordinator({
      flushInput: () => { throw new Error("tcflush failed"); },
      input,
      output,
    });
    const ordinary = coordinator.question("ordinary> ");
    input.write("command\npretyped\n");
    expect(await ordinary).toBe("command");

    const boundary = coordinator.establishProtectedInputBoundary();
    await settleStreams();
    input.write("kernel-tail-must-be-discarded\n");
    input.end();
    await expect(boundary).rejects.toThrow("could not establish an empty input queue");
    expect(output.value).toContain("discard input until EOF");
    expect(await coordinator.question("still-closed> ")).toBeNull();
    coordinator.close();
  });

  test("fences quarantine immediately when its instruction display closes", async () => {
    const input = new PassThrough();
    const output = new CapturingTty(80);
    const coordinator = new ShellTerminalCoordinator({
      flushInput: () => undefined,
      input,
      output,
    });
    const ordinary = coordinator.question("ordinary> ");
    input.write("command\npretyped\n");
    expect(await ordinary).toBe("command");

    const boundary = coordinator.establishProtectedInputBoundary();
    await settleStreams();
    output.destroy();
    await settleStreams();
    expect(await boundary).toBe(1);
    expect(input.destroyed).toBe(true);
    expect(await coordinator.question("still-closed> ")).toBeNull();
    coordinator.close();
  });

  test("keeps live output held and hold depth consistent through protected quarantine", async () => {
    const input = new PassThrough();
    const output = new CapturingTty(80);
    const coordinator = new ShellTerminalCoordinator({
      flushInput: () => { throw new Error("tcflush failed"); },
      input,
      output,
    });

    await coordinator.withLiveOutputHeld(async () => {
      const boundary = coordinator.establishProtectedInputBoundary();
      await settleStreams();
      coordinator.writeLive("LIVE DURING QUARANTINE");
      expect(output.value).not.toContain("LIVE DURING QUARANTINE");
      input.end();
      await expect(boundary).rejects.toThrow("could not establish an empty input queue");
    });
    expect(output.value).not.toContain("LIVE DURING QUARANTINE");

    await coordinator.withLiveOutputHeld(async () => {
      coordinator.writeLive("LIVE AFTER QUARANTINE");
      expect(output.value).not.toContain("LIVE AFTER QUARANTINE");
    });
    expect(output.value).not.toContain("LIVE AFTER QUARANTINE");
    coordinator.close();
  });

  test("discards held output from an observer generation before selection changes", async () => {
    const fixture = terminalFixture(40);
    await fixture.coordinator.withLiveOutputHeld(async () => {
      fixture.coordinator.writeLive("OLD SESSION UPDATE");
      fixture.coordinator.discardHeldLiveOutput();
      fixture.coordinator.writeLive("NEW SESSION UPDATE");
    });
    expect(fixture.output.value).not.toContain("OLD SESSION UPDATE");
    expect(fixture.output.value).toContain("NEW SESSION UPDATE");
    fixture.coordinator.close();
  });

  test("keeps overflow and protected-boundary quarantine authoritative when display writes throw", async () => {
    for (const boundary of ["overflow", "protected"] as const) {
      const input = new PassThrough();
      const output = new CapturingTty(80);
      const coordinator = new ShellTerminalCoordinator({
        flushInput: boundary === "protected"
          ? () => { throw new Error("tcflush failed"); }
          : () => undefined,
        input,
        output,
      });
      const ordinary = coordinator.question("ordinary> ");
      const lines = boundary === "overflow"
        ? Array.from({ length: 258 }, (_, index) => `line-${String(index)}`).join("\n")
        : "command\npretyped";
      input.write(`${lines}\n`);
      expect(await ordinary).toBe(boundary === "overflow" ? "line-0" : "command");
      output.write = (() => { throw new Error("display unavailable"); }) as typeof output.write;
      const quarantined = boundary === "overflow"
        ? coordinator.question("must-not-open> ")
        : coordinator.establishProtectedInputBoundary();
      const protectedRejection = boundary === "protected"
        ? expect(quarantined).rejects.toThrow("could not establish an empty input queue")
        : null;
      await settleStreams();
      if (!input.destroyed) {
        input.write("tail-must-be-drained\n");
        input.end();
      }
      if (boundary === "overflow") expect(await quarantined).toBeNull();
      else await protectedRejection;
      expect(input.destroyed).toBe(true);
      expect(input.read()).toBeNull();
      coordinator.close();
    }
  });

  test("bounds queued live output while the terminal is backpressured", async () => {
    const input = new PassThrough();
    const output = new BlockingOutput();
    const coordinator = new ShellTerminalCoordinator({ input, output, terminal: false });

    coordinator.writeLive("first update");
    for (let index = 0; index < 10_000; index += 1) {
      coordinator.writeLive("x".repeat(1_024));
    }
    expect(output.writableNeedDrain).toBe(true);
    expect(output.writableLength).toBeLessThan(2_048);

    output.release();
    await settleStreams();
    expect(output.value).toContain("additional live updates omitted while the terminal was backpressured");
    output.release();
    await settleStreams();
    coordinator.close();
  });

  test("fences active input without throwing from a failed backpressure drain notice", async () => {
    const fixture = terminalFixture(40);
    const answer = fixture.coordinator.question("hra> ");
    await settleStreams();
    fixture.input.write("draft");
    await settleStreams();

    const originalWrite = fixture.output.write.bind(fixture.output);
    let rejectLiveBlock = true;
    fixture.output.write = ((chunk: unknown, ...arguments_: unknown[]) => {
      const value = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      const accepted = originalWrite(chunk as never, ...(arguments_ as never[]));
      if (rejectLiveBlock && value === "first update\n") {
        rejectLiveBlock = false;
        return false;
      }
      return accepted;
    }) as typeof fixture.output.write;
    fixture.coordinator.writeLive("first update");
    fixture.coordinator.writeLive("omitted update");

    fixture.output.write = (() => {
      throw new Error("display unavailable during drain");
    }) as typeof fixture.output.write;
    expect(() => fixture.output.emit("drain")).not.toThrow();
    fixture.input.write("-must-be-quarantined\n");
    fixture.input.end();

    expect(await answer).toBeNull();
    expect(fixture.input.read()).toBeNull();
    expect(await fixture.coordinator.question("next> ")).toBeNull();
    fixture.coordinator.close();
  });

  test("drains typeahead that arrived while no ordinary question was attached", async () => {
    const fixture = terminalFixture(40);
    const first = fixture.coordinator.question("ordinary> ");
    fixture.input.write("command\n");
    expect(await first).toBe("command");

    fixture.input.write("pretyped-protected-value\n");
    expect(fixture.coordinator.discardBufferedInput()).toBeGreaterThan(0);
    const protectedTerminal = createInterface({
      input: fixture.input,
      output: fixture.output,
      terminal: true,
      historySize: 0,
    });
    const protectedAnswer = protectedTerminal.question("protected> ");
    fixture.input.write("entered-after-prompt\n");
    expect(await protectedAnswer).toBe("entered-after-prompt");
    protectedTerminal.close();
    fixture.coordinator.close();
  });

  test("writes idle updates verbatim and cleanup is idempotent", async () => {
    const fixture = terminalFixture(20);
    fixture.coordinator.writeLive("idle without newline");
    expect(fixture.output.value).toBe("idle without newline");

    const answer = fixture.coordinator.question("hra> ");
    await settleStreams();
    fixture.coordinator.close();
    fixture.coordinator.close();
    expect(await answer).toBeNull();
    const afterClose = fixture.output.value;
    fixture.coordinator.writeLive(" after close");
    expect(fixture.output.value).toBe(afterClose);
    expect(await fixture.coordinator.question("ignored> ")).toBeNull();
  });

  test("releases readline between questions for protected terminal input", async () => {
    const fixture = terminalFixture(40);
    const first = fixture.coordinator.question("first> ");
    fixture.input.write("ordinary\n");
    expect(await first).toBe("ordinary");

    await fixture.coordinator.withLiveOutputHeld(async () => {
      const protectedTerminal = createInterface({
        input: fixture.input,
        output: fixture.output,
        terminal: true,
        historySize: 0,
      });
      const protectedAnswer = protectedTerminal.question("protected> ");
      fixture.coordinator.writeLive("LIVE DURING PROTECTED INPUT");
      expect(fixture.output.value).not.toContain("LIVE DURING PROTECTED INPUT");
      fixture.input.write("sensitive\n");
      expect(await protectedAnswer).toBe("sensitive");
      protectedTerminal.close();
    });
    expect(fixture.output.value).toContain("LIVE DURING PROTECTED INPUT");

    const second = fixture.coordinator.question("second> ");
    fixture.input.write("ordinary again\n");
    expect(await second).toBe("ordinary again");
    fixture.coordinator.close();
  });
});
