import { ConvexReactClient } from "convex/react";

import { convexDeploymentUrl } from "../env";

/**
 * One websocket client for the pinned deployment. The client derives its
 * websocket origin from this https origin, and both are named in the
 * `connect-src` allowlist of `app/vercel.json`.
 */
export const convexClient = new ConvexReactClient(convexDeploymentUrl, {
  unsavedChangesWarning: false,
  verbose: false,
});
