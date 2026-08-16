/**
 * A validated public Convex deployment configuration.
 *
 * Live products use a ready URL to construct their official Convex client. Deterministic Direct
 * compositions instead inject a product-owned backend port; they must not imitate Convex's
 * WebSocket, cache, transaction, or database behavior.
 */
export type ConvexDeployment =
  | { readonly kind: "missing" }
  | {
      readonly input: string;
      readonly kind: "invalid";
      readonly message: string;
      readonly reason: "credentials" | "insecure-remote" | "not-a-url" | "not-an-origin";
    }
  | {
      readonly kind: "ready";
      readonly origin: string;
      readonly transport: "cloud" | "local";
      readonly url: string;
    };

const localHostnames = new Set(["127.0.0.1", "[::1]", "localhost"]);

function invalid(
  input: string,
  reason: Extract<ConvexDeployment, { readonly kind: "invalid" }>["reason"],
  message: string,
): ConvexDeployment {
  return { input, kind: "invalid", message, reason };
}

/** Parse untrusted public configuration into a safe Convex deployment origin. */
export function parseConvexDeployment(value: unknown): ConvexDeployment {
  if (typeof value !== "string" || value.trim() === "") return { kind: "missing" };

  const input = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return invalid(input, "not-a-url", "Use a complete Convex deployment URL.");
  }

  if (parsed.username !== "" || parsed.password !== "") {
    return invalid(input, "credentials", "Deployment URLs cannot contain credentials.");
  }

  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    return invalid(input, "not-an-origin", "Use the deployment origin without a path or query.");
  }

  const local = localHostnames.has(parsed.hostname);
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    return invalid(input, "insecure-remote", "Remote Convex deployments must use HTTPS.");
  }

  return {
    kind: "ready",
    origin: parsed.origin,
    transport: local ? "local" : "cloud",
    url: parsed.origin,
  };
}
