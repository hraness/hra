import {
  HRA_INSTALL_ARCHIVE_URL,
  HRA_INSTALL_BUN_VERSION,
  HRA_INSTALL_SUCCESS,
  installHraRelease,
} from "./install-preflight-runtime";

export { HRA_INSTALL_ARCHIVE_URL, HRA_INSTALL_BUN_VERSION };

export const HRA_INSTALL_PREFLIGHT_SOURCE_URL =
  "https://raw.githubusercontent.com/hraness/hra/v0.1.0/src/install-preflight-runtime.ts";
export const HRA_INSTALL_PREFLIGHT_SOURCE_SHA256 =
  "8f64f735eddcf1b364dc3964305249a0544a7c64aaac268b3af8c46621ec0311";
export const HRA_INSTALL_PREFLIGHT_SUCCESS = HRA_INSTALL_SUCCESS;
export const HRA_INSTALL_PREFLIGHT_LOADER = [
  "const[a,h]=process.argv.slice(1);",
  "const b=await Bun.stdin.bytes();",
  "const d=new Bun.CryptoHasher(\"sha256\").update(b).digest(\"hex\");",
  "if(d!==h)throw new Error(\"The tagged HRA preflight digest is invalid.\");",
  "const j=new Bun.Transpiler({loader:\"ts\",target:\"bun\"}).transformSync(b);",
  "const u=URL.createObjectURL(new Blob([j],{type:\"text/javascript\"}));",
  "try{const m=await import(u);await m.installHraRelease(a);process.stdout.write(`${m.HRA_INSTALL_SUCCESS}\\n`);}finally{URL.revokeObjectURL(u)}",
].join("");

export const buildHraGlobalInstallCommand = (archive: string): string => {
  if (archive !== HRA_INSTALL_ARCHIVE_URL) {
    throw new Error("The public HRA installer accepts only its exact immutable release archive URL.");
  }
  return `test "$(curl -fsSL --connect-timeout 10 --max-time 60 --retry 3 --retry-delay 1 --retry-max-time 60 --proto '=https' --tlsv1.2 ${HRA_INSTALL_PREFLIGHT_SOURCE_URL} | bun -e '${HRA_INSTALL_PREFLIGHT_LOADER}' -- ${archive} ${HRA_INSTALL_PREFLIGHT_SOURCE_SHA256})" = ${HRA_INSTALL_PREFLIGHT_SUCCESS}`;
};

if (import.meta.main) {
  try {
    if (process.argv.length !== 3 || typeof process.argv[2] !== "string") {
      throw new Error("The HRA installer requires exactly one release archive.");
    }
    await installHraRelease(process.argv[2]);
    process.stdout.write(`${HRA_INSTALL_PREFLIGHT_SUCCESS}\n`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "The HRA installation was refused.";
    process.stderr.write(`hra install: ${message}\n`);
    process.exitCode = 1;
  }
}
