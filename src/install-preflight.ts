import {
  HRA_INSTALL_ARCHIVE_URL,
  HRA_INSTALL_BUN_VERSION,
  HRA_INSTALL_RUNTIME_INJECTION_ENVIRONMENT_NAMES,
  HRA_INSTALL_SUCCESS,
  installHraRelease,
} from "./install-preflight-runtime";

export { HRA_INSTALL_ARCHIVE_URL, HRA_INSTALL_BUN_VERSION };

export const HRA_INSTALL_PREFLIGHT_SOURCE_URL =
  "https://raw.githubusercontent.com/hraness/hra/v0.6.2/src/install-preflight-runtime.ts";
export const HRA_INSTALL_PREFLIGHT_SOURCE_SHA256 =
  "7bd368621ecbe4dfbe44de701d8493b43884c4c44536c72fe643708173ea61f3";
export const HRA_INSTALL_PREFLIGHT_SOURCE_MAXIMUM_BYTES = 512 * 1024;
export const HRA_INSTALL_PREFLIGHT_SUCCESS = HRA_INSTALL_SUCCESS;
export const HRA_INSTALL_PREFLIGHT_LOADER = [
  `const n=${JSON.stringify(HRA_INSTALL_RUNTIME_INJECTION_ENVIRONMENT_NAMES)},x=process.execArgv;`,
  "const c=x.filter(v=>v===\"-c\"||v.startsWith(\"--config\"));",
  "if(n.some(k=>process.env[k]!==undefined)||x.filter(v=>v===\"--no-env-file\").length!==1||c.length!==1||c[0]!==\"--config=/dev/null\"||x.some(v=>v.startsWith(\"-r\")||v===\"--preload\"||v.startsWith(\"--preload=\")||v===\"--require\"||v.startsWith(\"--require=\")||v===\"--import\"||v.startsWith(\"--import=\")||v===\"--env-file\"||v.startsWith(\"--env-file=\")))throw new Error(\"The tagged HRA preflight requires a neutral Bun stage zero.\");",
  "const[a,h]=process.argv.slice(1);",
  "const r=Bun.stdin.stream().getReader(),q=[];let z=0;",
  `try{for(;;){const o=await r.read();if(o.done)break;z+=o.value.byteLength;if(z>${String(HRA_INSTALL_PREFLIGHT_SOURCE_MAXIMUM_BYTES)})throw new Error("The tagged HRA preflight exceeds its byte limit.");q.push(o.value)}}finally{r.releaseLock()}`,
  "const b=new Uint8Array(z);let p=0;for(const v of q){b.set(v,p);p+=v.byteLength}",
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
  const unsetRuntimeInjection = HRA_INSTALL_RUNTIME_INJECTION_ENVIRONMENT_NAMES.join(" ");
  return `test "$(unset ${unsetRuntimeInjection} && curl -fsSL --connect-timeout 10 --max-time 60 --max-filesize ${String(HRA_INSTALL_PREFLIGHT_SOURCE_MAXIMUM_BYTES)} --retry 3 --retry-delay 1 --retry-max-time 60 --proto '=https' --tlsv1.2 ${HRA_INSTALL_PREFLIGHT_SOURCE_URL} | command bun --no-env-file --config=/dev/null -e '${HRA_INSTALL_PREFLIGHT_LOADER}' -- ${archive} ${HRA_INSTALL_PREFLIGHT_SOURCE_SHA256})" = ${HRA_INSTALL_PREFLIGHT_SUCCESS}`;
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
