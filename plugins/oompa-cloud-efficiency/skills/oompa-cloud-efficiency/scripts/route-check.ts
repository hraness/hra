#!/usr/bin/env bun

import {
  dispatchPacketHeader,
  parseRouteArguments,
  routeTask,
} from "./routing";

if (import.meta.main) {
  try {
    const options = parseRouteArguments(process.argv.slice(2));
    const report = routeTask(options);
    if (options.packet && report.decision === "local") {
      throw new Error("--packet is unavailable because this task must stay local");
    }
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else {
      const state = report.dispatchReady
        ? "DISPATCH_READY"
        : report.decision === "local" ? "ROUTE_LOCAL" : "ROUTE_QUALIFIED";
      console.log([
        state,
        `decision=${report.decision}`,
        ...(report.decision === "local" ? [] : [
          `repository=${report.repository}`,
          `branch=${report.branch}`,
          `sha=${report.sha}`,
        ]),
        `owner=${report.owner}`,
        `profile=${report.profile ?? "not-applicable"}`,
        `online=${report.decision === "local"
          ? "not-applicable"
          : report.onlineVerified ? "verified" : "not-verified"}`,
        `environment=${report.environmentConfigured ? "configured" : "missing"}`,
      ].join("\t"));
      for (const next of report.next) console.log(`NEXT\t${next}`);
    }
    if (options.packet) console.log(`\n${dispatchPacketHeader(report)}`);
  } catch (error: unknown) {
    console.error(`[hra-cloud-route] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
