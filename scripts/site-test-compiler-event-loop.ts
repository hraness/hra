import { MessageChannel } from "node:worker_threads";

/** Keep the isolated child alive until its explicit close join settles. */
export function holdSiteTestCompilerEventLoop(): () => void {
  // The library may unref its own child after shutdown starts. This separate
  // event-loop lease is not a timer, worker, signal, or cleanup proof.
  const channel = new MessageChannel();
  try {
    channel.port1.on("message", () => { process.exitCode = 1; });
    channel.port1.ref();
  } catch (error: unknown) {
    channel.port1.close(); channel.port2.close();
    throw error;
  }
  return () => { channel.port1.close(); channel.port2.close(); };
}
