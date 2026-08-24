import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const allowedPublicScopes = new Set([
  "auth",
  "convex-dev",
  "eslint",
  "openai",
  "types",
  "typescript-eslint",
]);

const secretPatterns = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  /\b(?:re|sk)_[A-Za-z0-9_-]{20,}\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  /\bnpm_[A-Za-z0-9]{30,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
  /\bAIza[0-9A-Za-z_-]{30,}\b/u,
  /\b(?:AUTH_SECRET|CONVEX_DEPLOY_KEY|HRA_AUTH_HMAC_SECRET|HRA_RESEND_API_KEY|OTP_HMAC_SECRET|RESEND_API_KEY)\s*[:=]\s*["']?[^\s"']{16,}/u,
] as const;

const absoluteUserPaths = [
  /\/(?:Users|home)\/[^/\s"'`]+\//u,
  /(?:^|[^A-Za-z0-9])[A-Za-z]:\\Users\\[^\\\s"'`]+\\/u,
] as const;
const scopedPackage = /@([a-z0-9][a-z0-9-]*)\//gu;

export class PublicTextPolicyError extends Error {
  constructor(
    readonly code: "ABSOLUTE_USER_PATH" | "PRIVATE_SCOPE" | "SECRET_SHAPE" | "UNREVIEWED_FILE_TYPE",
    readonly label: string,
  ) {
    super(`Public text policy rejected ${label}: ${code}.`);
    this.name = "PublicTextPolicyError";
  }
}

export function assertPublicText(value: string, label: string): void {
  assertPublicSensitiveText(value, label);

  for (const match of value.matchAll(scopedPackage)) {
    const scope = match[1];
    if (scope !== undefined && !allowedPublicScopes.has(scope)) {
      throw new PublicTextPolicyError("PRIVATE_SCOPE", label);
    }
  }
}

export function assertPublicSensitiveText(value: string, label: string): void {
  for (const pattern of absoluteUserPaths) {
    if (pattern.test(value)) {
      throw new PublicTextPolicyError("ABSOLUTE_USER_PATH", label);
    }
  }

  for (const pattern of secretPatterns) {
    if (pattern.test(value)) {
      throw new PublicTextPolicyError("SECRET_SHAPE", label);
    }
  }
}

const excludedDirectories = new Set([".git", "dist", "node_modules"]);
const textFile = /(?:^|\/)(?:LICENSE|\.bun-version|\.editorconfig|\.gitattributes|\.gitignore)$|\.(?:css|html|json|lock|md|mjs|svg|ts|tsx|txt|xml|yml|yaml)$/u;

export async function assertPublicTree(root: string): Promise<void> {
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      const label = relative(root, child);
      if (label === ".git" && (entry.isDirectory() || entry.isFile())) {
        continue;
      } else if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) await visit(child);
      } else if (entry.isFile() && textFile.test(child)) {
        const value = await readFile(child, "utf8");
        if (entry.name === "bun.lock") assertPublicSensitiveText(value, label);
        else assertPublicText(value, label);
      } else {
        throw new PublicTextPolicyError("UNREVIEWED_FILE_TYPE", label);
      }
    }
  };
  await visit(root);
}
