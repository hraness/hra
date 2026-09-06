import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { inspectEffectArchitecture } from "./check-effect-architecture.ts";

const directory = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = mkdtempSync(join(directory, ".architecture-fixtures-"));
const fixtures: Readonly<Record<string, string>> = {
  "program.ts": `import {Effect} from "effect"; export const program = Effect.gen(function*(){ yield* Effect.log("ok"); return 1; });`,
  "floating.ts": `import {Effect} from "effect"; export const program = Effect.gen(function*(){ Effect.log("forgotten"); return 1; });`,
  "voided.ts": `import {Effect} from "effect"; void Effect.succeed(1);`,
  "runner.ts": `import {runPromise as execute, succeed} from "effect/Effect"; export const x=execute(succeed(1));`,
  "aliased-runner.ts": `import {Effect} from "effect"; const execute=Effect.runPromise; export const x=execute(Effect.succeed(1));`,
  "computed-runner.ts": `import {Effect} from "effect"; export const x=Effect["runPromise"](Effect.succeed(1));`,
  "runtime-construction.ts": `import {ManagedRuntime,Layer} from "effect"; export const x=ManagedRuntime.make(Layer.empty);`,
  "destructured-runner.ts": `import {Effect} from "effect"; const {runPromise:execute}=Effect; export const x=execute(Effect.succeed(1));`,
  "local-destructured.ts": `import {Effect} from "effect"; const local={runPromise:()=>Effect.succeed(1)}; const {runPromise:execute}=local; export const x=execute();`,
  "unused.ts": `import {Effect} from "effect"; export const x=Effect.gen(function*(){ const dropped=Effect.log("forgotten"); return 1; });`,
  "shorthand.ts": `import {Effect} from "effect"; export function make(){ const effect=Effect.succeed(1); return {effect}; }`,
  "assigned.ts": `import {Effect,Exit} from "effect"; export function make(){ let result:Exit.Exit<number,string>=Exit.succeed(1); result=Exit.fail("failure"); return result; }`,
  "assigned-unused.ts": `import {Effect} from "effect"; export function make(){ let task:Effect.Effect<void>; task=Effect.log("forgotten"); return 1; }`,
  "root.ts": `import {Effect} from "effect"; export const run=<A>(program:Effect.Effect<A,never,never>)=>Effect.runPromise(program);`,
  "ambient.ts": `import {Effect} from "effect"; export const x=Effect.sync(()=>Date.now()+Math.random());`,
  "shadowed.ts": `import {Effect} from "effect"; const fetch=()=>Effect.succeed(1); export const x=fetch();`,
  "adapter.ts": `import {Effect} from "effect"; import {readFile} from "node:fs/promises"; export const read=Effect.tryPromise({try:()=>readFile("sample"),catch:()=>({ _tag:"ReadFailed" as const })});`,
  "native.ts": `import {Effect} from "effect"; import {readFile} from "node:fs/promises"; export const read=Effect.tryPromise({try:()=>readFile("sample"),catch:()=>({ _tag:"ReadFailed" as const })});`,
  "native-dynamic.ts": `import {Effect} from "effect"; export const read=Effect.tryPromise({try:()=>import("node:fs/promises"),catch:()=>({ _tag:"ReadFailed" as const })});`,
  "adapter-dynamic.ts": `import {Effect} from "effect"; export const read=Effect.tryPromise({try:()=>import("node:fs/promises"),catch:()=>({ _tag:"ReadFailed" as const })});`,
  "unknown-error.ts": `import {Effect} from "effect"; export const x:Effect.Effect<number,unknown>=Effect.fail("bad");`,
  "any-error.ts": `import {Effect} from "effect"; export const x:Effect.Effect<number,any>=Effect.succeed(1);`,
  "asserted.ts": `import {Effect} from "effect"; export const x=Effect.fail("bad") as Effect.Effect<never,never>;`,
  "erased.ts": `import {Effect} from "effect"; export const x=Effect.orDie(Effect.fail("bad"));`,
  "suppressed.ts": `import {Effect} from "effect"; // @ts-ignore\nexport const x=Effect.succeed(1);`,
  "suppressed-error.ts": `import {Effect} from "effect"; // @ts-expect-error\nexport const x:Effect.Effect<never,never>=Effect.fail("bad");`,
  "unclassified.ts": `import {Effect} from "effect"; export const x=Effect.succeed(1);`,
  "unclassified-dynamic.ts": `export const load=()=>import("effect");`,
};
for(const [name, source] of Object.entries(fixtures)) writeFileSync(join(fixtureRoot,name),source);
const program=ts.createProgram({rootNames:Object.keys(fixtures).map(name=>join(fixtureRoot,name)),options:{
  strict:true,noEmit:true,skipLibCheck:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.NodeNext,
  moduleResolution:ts.ModuleResolutionKind.NodeNext,types:[],
}});
const findings=inspectEffectArchitecture(program,{
  root:fixtureRoot,modules:Object.keys(fixtures).filter(n=>!n.startsWith("unclassified")),
  adapters:["adapter.ts","adapter-dynamic.ts"],runtimeRoots:["root.ts"],
});
const rules=(file:string)=>findings.filter(f=>f.file===file).map(f=>f.rule);
try {
  test("accepts composed programs, real root and adapter, and a local fetch service",()=>{
    for(const file of ["program.ts","root.ts","adapter.ts","adapter-dynamic.ts","shadowed.ts","shorthand.ts","assigned.ts","local-destructured.ts"]) expect(rules(file)).toEqual([]);
  });
  test("finds real typed floating Effects even when voided",()=>{
    expect(rules("floating.ts")).toContain("floating-effect");
    expect(rules("voided.ts")).toContain("floating-effect");
    expect(rules("unused.ts")).toContain("unused-effect");
    expect(rules("assigned-unused.ts")).toContain("floating-effect");
  });
  test("recognizes namespace, named, local alias and computed runtime entrypoints",()=>{
    for(const file of ["runner.ts","aliased-runner.ts","computed-runner.ts","runtime-construction.ts","destructured-runner.ts"]) expect(rules(file)).toContain("runtime-owner");
  });
  test("requires adapter ownership for native I/O and ambient clocks",()=>{
    expect(rules("ambient.ts")).toContain("ambient-io");
    expect(rules("native.ts")).toContain("native-import");
    expect(rules("native-dynamic.ts")).toContain("native-import");
  });
  test("rejects erased channels, unsafe assertions and defect conversion",()=>{
    expect(rules("unknown-error.ts")).toContain("explicit-channel");
    expect(rules("any-error.ts")).toContain("explicit-channel");
    expect(rules("any-error.ts")).toContain("explicit-any");
    expect(rules("asserted.ts")).toContain("effect-assertion");
    expect(rules("erased.ts")).toContain("erased-failure");
  });
  test("requires roles for new production Effect modules and refuses suppressions",()=>{
    expect(rules("unclassified.ts")).toContain("unclassified-module");
    expect(rules("unclassified-dynamic.ts")).toContain("unclassified-module");
    expect(rules("suppressed.ts")).toContain("suppression");
    expect(rules("suppressed-error.ts")).toContain("suppression");
  });
  test("fails closed when a governed file is not in the compilation",()=>{
    expect(inspectEffectArchitecture(program,{root:fixtureRoot,modules:["missing.ts"],adapters:[],runtimeRoots:[]})
      .some(f=>f.rule==="policy-source")).toBe(true);
  });
} finally {
  rmSync(fixtureRoot,{recursive:true,force:true});
}
