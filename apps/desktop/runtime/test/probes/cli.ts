#!/usr/bin/env bun

import {
  runProtocolProbeSuite,
  type ProtocolProbeEvidence,
  type ProtocolProbeName,
} from "./scenarios";
import { errorMessage } from "./jsonl";

interface CliOptions {
  readonly binaryPath: string | undefined;
  readonly expectedVersion: string | undefined;
  readonly scenarios: ReadonlyArray<ProtocolProbeName>;
  readonly interactive: boolean | undefined;
  readonly accountCodexHome: string | undefined;
  readonly dynamicToolRegistrationField: string | undefined;
}

const ALL_SCENARIOS = [
  "initialize",
  "fork-cwd",
  "ephemeral-promotion",
  "pending-request-replay",
  "dynamic-tool-registration",
] as const satisfies ReadonlyArray<ProtocolProbeName>;

const options = parseArguments(process.argv.slice(2));

try {
  const evidence = await runProtocolProbeSuite(options);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  process.exitCode = evidence.summary.failed === 0 ? 0 : 1;
} catch (error: unknown) {
  const evidence = fatalEvidence(error);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  process.exitCode = 1;
}

function parseArguments(args: ReadonlyArray<string>): CliOptions {
  let binaryPath: string | undefined;
  let expectedVersion: string | undefined;
  let accountCodexHome: string | undefined;
  let interactive: boolean | undefined;
  let dynamicToolRegistrationField: string | undefined;
  let scenarios: ReadonlyArray<ProtocolProbeName> = ALL_SCENARIOS;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) {
      throw new Error("argument iteration exceeded the provided arguments");
    }
    switch (argument) {
      case "--codex-bin":
        binaryPath = requiredValue(args, ++index, argument);
        break;
      case "--expected-version":
        expectedVersion = requiredValue(args, ++index, argument);
        break;
      case "--account-codex-home":
        accountCodexHome = requiredValue(args, ++index, argument);
        break;
      case "--dynamic-tool-registration-field":
        dynamicToolRegistrationField = requiredValue(args, ++index, argument);
        break;
      case "--scenario": {
        const value = requiredValue(args, ++index, argument);
        scenarios = value === "all" ? ALL_SCENARIOS : [parseScenario(value)];
        break;
      }
      case "--interactive":
        interactive = true;
        break;
      case "--no-interactive":
        interactive = false;
        break;
      case "--help":
        return showHelp();
      default:
        throw new Error(`unknown argument ${String(argument)}\n\n${helpText()}`);
    }
  }

  return {
    binaryPath,
    expectedVersion,
    scenarios,
    interactive,
    accountCodexHome,
    dynamicToolRegistrationField,
  };
}

function showHelp(): never {
  process.stderr.write(helpText());
  process.exit(0);
}

function requiredValue(args: ReadonlyArray<string>, index: number, flag: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseScenario(value: string): ProtocolProbeName {
  switch (value) {
    case "initialize":
    case "fork-cwd":
    case "ephemeral-promotion":
    case "pending-request-replay":
    case "dynamic-tool-registration":
      return value;
    default:
      throw new Error(`unknown scenario ${value}; expected all or ${ALL_SCENARIOS.join(", ")}`);
  }
}

function fatalEvidence(error: unknown): ProtocolProbeEvidence | Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    kind: "oprte.phase1.codex-protocol-evidence",
    startedAt: now,
    finishedAt: now,
    results: [
      {
        name: "probe-bootstrap",
        status: "failed",
        durationMs: 0,
        reason: errorMessage(error),
      },
    ],
    summary: { passed: 0, failed: 1, skipped: 0, complete: false },
  };
}

function helpText(): string {
  return `Usage: bun runtime/test/probes/cli.ts [options]\n\nOptions:\n  --codex-bin <absolute path>       Exact Codex executable (or set HRA_CODEX_BIN)\n  --expected-version <x.y.z>        Exact expected version (or use the root catalog pin)\n  --scenario <name|all>             Select a single scenario; default: all\n  --interactive                     Permit model-consuming probes\n  --no-interactive                  Force model-consuming probes to skip\n  --account-codex-home <path>       Isolated signed-in CODEX_HOME for interactive probes\n  --dynamic-tool-registration-field <field>\n                                     Candidate thread/start field from upstream evidence\n  --help                             Show this help\n\nInteractive probes never infer the default Codex profile. Set both --interactive and\n--account-codex-home (or HRA_RUN_INTERACTIVE_PROBES=1 and HRA_PROBE_CODEX_HOME).\nThe dynamic-tool probe additionally requires an upstream-sourced registration field; it\nnever guesses or enables a production field.\n`;
}
