import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import {
  assertAuthoritySupervisorArtifactPublicFile,
  isAuthoritySupervisorArtifactRelativePath,
} from "./authority-supervisor-artifact";

const allowedPublicScopes = new Set([
  "auth",
  "convex-dev",
  "eslint",
  "letta-ai",
  "openai",
  "tailwindcss",
  "types",
  "typescript-eslint",
  "vitejs",
]);
const allowedPublicScopedPackages = new Set([
  "@hraness/atet",
  "@hraness/design-kit",
  "@hraness/hra",
  "@hraness/oh",
  "@hraness/posthog",
  "@hraness/site-footer",
  "@hraness/ui",
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
const scopedPackage = /@([a-z0-9][a-z0-9-]*)\/[a-z0-9][a-z0-9._-]*/gu;
const gitTagReferencePackageShape = ["@refs", "tags"].join("/");

export class PublicTextPolicyError extends Error {
  constructor(
    readonly code: "ABSOLUTE_USER_PATH" | "EM_DASH" | "PRIVATE_SCOPE" | "SECRET_SHAPE" | "UNREVIEWED_FILE_TYPE",
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
    const packageName = match[0];
    const matchEnd = match.index + packageName.length;
    const isGitTagReference = packageName === gitTagReferencePackageShape && value[matchEnd] === "/";
    if (
      scope !== undefined
      && !allowedPublicScopes.has(scope)
      && !allowedPublicScopedPackages.has(packageName)
      && !isGitTagReference
    ) {
      throw new PublicTextPolicyError("PRIVATE_SCOPE", label);
    }
  }
}

/**
 * Public copy follows STYLE.md and WRITING.md, which both ban the em dash.
 * The check is separate from `assertPublicText` because that function also
 * scans historical commit patches and vendored text that this rule does not
 * govern.
 */
export function assertPublicCopyText(value: string, label: string): void {
  if (value.includes("\u2014")) {
    throw new PublicTextPolicyError("EM_DASH", label);
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
/**
 * Files whose prose is public copy: root Markdown, the package manifest, the
 * generated-site source, published docs, and the GitHub issue templates.
 */
const publicCopyFile = /^(?:[A-Z_]+\.md|package\.json|site\/.+|docs\/.+\.md|\.github\/ISSUE_TEMPLATE\/.+)$/u;
const textFile = /(?:^|\/)(?:CODEOWNERS|LICENSE|\.bun-version|\.editorconfig|\.gitattributes|\.gitignore)$|\.(?:css|html|json|lock|md|mjs|svg|toml|ts|tsx|txt|xml|yaml|yml|zig)$/u;
const editorialWebp = /^site\/images\/editorial\/[a-z0-9]+(?:-[a-z0-9]+)*(?:-384|-768)?\.webp$/u;
const webpChunkTypes = new Set(["VP8 ", "VP8L", "VP8X"]);

const assertEditorialWebp = async (path: string, label: string): Promise<void> => {
  const bytes = await readFile(path);
  const riffSize = bytes.byteLength >= 8 ? bytes.readUInt32LE(4) : -1;
  const chunkType = bytes.byteLength >= 16 ? bytes.toString("ascii", 12, 16) : "";
  if (
    bytes.byteLength < 20
    || bytes.byteLength > 2_000_000
    || bytes.toString("ascii", 0, 4) !== "RIFF"
    || riffSize !== bytes.byteLength - 8
    || bytes.toString("ascii", 8, 12) !== "WEBP"
    || !webpChunkTypes.has(chunkType)
  ) {
    throw new PublicTextPolicyError("UNREVIEWED_FILE_TYPE", label);
  }
};

export async function assertPublicTree(root: string): Promise<void> {
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      const label = relative(root, child);
      if (label === ".git" && (entry.isDirectory() || entry.isFile())) {
        continue;
      } else if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) await visit(child);
      } else if (entry.isFile() && isAuthoritySupervisorArtifactRelativePath(label)) {
        await assertAuthoritySupervisorArtifactPublicFile(root, label);
      } else if (entry.isFile() && editorialWebp.test(label)) {
        await assertEditorialWebp(child, label);
      } else if (entry.isFile() && textFile.test(child)) {
        const value = await readFile(child, "utf8");
        if (entry.name === "bun.lock") assertPublicSensitiveText(value, label);
        else assertPublicText(value, label);
        if (publicCopyFile.test(label)) assertPublicCopyText(value, label);
      } else {
        throw new PublicTextPolicyError("UNREVIEWED_FILE_TYPE", label);
      }
    }
  };
  await visit(root);
}
