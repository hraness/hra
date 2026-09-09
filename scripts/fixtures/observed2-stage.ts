import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

// Exact synthetic archived storage evidence. Provenance distinguishes released
// writer outputs from passive uncommitted stages. No native provider claim.
export const observed2Fixture = {
  "generatorSha256": "f2c28a8cfbd4c44f397082652cd79a19483074458daaff9ef1d25ed5ac206bf8",
  "bunVersion": "1.3.14",
  "sources": {
    "canonical10": {
      "commit": "42d91955132816626ce35ae8afc4bc330ba38170",
      "tree": "b6c160d105787df4014b149503fbda82ec8835df",
      "sourceFileCount": 119,
      "manifest": "37971033b9487826b2d3bb379f8c63593c419b0a9a69473fea9bf372b8ef3406",
      "pins": {
        "src/storage/state-store.ts": "6cdee2a6cc9f45f47388169611788f997bce0fe640fa61b9c124785f36d5960e",
        "package.json": "4ea731562dba841f3c28b0d899d2b91e14353d4b2fc867a70d8e8ccf5670c00d",
        "bun.lock": "650f295c061c3573d0fb4b5542f12977d8e4b5ab8b65d1e019b290f4a205011d"
      }
    }
  },
  "dependencies": {
    "@openai/codex": "0.149.0",
    "convex": "1.45.0",
    "zod": "4.4.3"
  },
  "dependencyManifestHashes": {
    "@openai/codex": "0580493a92b83d962b8fdc8585a66c963431c6ddb54fabe4b3797970095f000d",
    "convex": "aa9f5baee26b69a88d6b61180e540cce1f52baa31094e7124c8c0393e4b3211e",
    "zod": "c630bd10b52dcf71c112a2bf78dbf2734b9db58d62de663b8d86c2ec2c8cda2e"
  },
  "schemaVersion": 2,
  "databaseSha256": "d7ccfdf27ce3b6f64d0efad5031734dbfff7421c87a7b9192c53e06572a15ee7",
  "databaseBytes": 122880,
  "snapshot": {
    "sha256": "4a60cf970dbc9f20ad384fa457f6e765964f4a49028d5d23ec774c9bf16e162a",
    "schemaSha256": "d8c75c0f016ac4486cd519f920099ee9229a35dd8ed6dec1bcd5c610293ced5f",
    "version": {
      "user_version": 2
    },
    "ledger": [
      {
        "version": 1,
        "applied_at": 10001
      },
      {
        "version": 2,
        "applied_at": 10001
      }
    ],
    "rowCounts": {
      "daemon_state": 1,
      "desktop_switches": 0,
      "migrations": 2,
      "mutation_attempts": 0,
      "profiles": 0,
      "projects": 0,
      "queue_entries": 0,
      "sessions": 0,
      "turn_summaries": 0,
      "usage_snapshots": 0
    }
  },
  "final10SnapshotSha256": "045c0b8fa7bf1872881a1d58004ed9bb792e40aba0b941a871baf817a630cf46",
  "provenance": {
    "kind": "uncommitted_archived_migration_stage",
    "releasedWriterImage": false,
    "marker": "PRAGMA user_version = 2",
    "observedBeforeOuterCommit": true,
    "observerRowOrSchemaWrites": false,
    "originalProfilesAndSessionsEmpty": true,
    "standaloneSnapshotAndBytesUnchanged": true,
    "final10WritableAndReadonlyReopensUnchanged": true,
    "final10ReadonlyBytesUnchanged": true,
    "providerEffects": 0,
    "sourceAndDependenciesReverifiedAfterUse": true
  }
} as const;

export const observed2GeneratorSource = "// Passive empty schema2 stage from exact archived10 source. Tests may add\n// explicitly synthetic rows later; no released schema2 writer is claimed.\nimport { createHash } from \"node:crypto\";\nimport { lstatSync, readdirSync, readFileSync } from \"node:fs\";\nimport { mkdir, writeFile } from \"node:fs/promises\";\nimport { join, relative } from \"node:path\";\nimport { Database } from \"bun:sqlite\";\nimport { z } from \"zod\";\n\nconst sha256 = (value: string | Uint8Array) => createHash(\"sha256\").update(value).digest(\"hex\");\nconst readBounded = (path: string, maximum = 8 * 1024 * 1024) => {\n  const stat = lstatSync(path);\n  if (!stat.isFile() || stat.size > maximum) throw new Error(\"CAPTURE_FILE_LIMIT\");\n  return readFileSync(path);\n};\nconst hostPrefixes = [[\"\", \"Users\", \"\"], [\"\", \"home\", \"\"], [\"\", \"private\", \"\"],\n  [\"\", \"tmp\", \"\"], [\"\", \"var\", \"folders\", \"\"]].map((parts) => parts.join(\"/\"));\nhostPrefixes.push([\"\", \"Users\", \"\"].join(\"\\\\\"));\nconst assertPrivatePathFree = (input: Uint8Array) => {\n  const bytes = Buffer.from(input);\n  for (const prefix of hostPrefixes) for (const needle of [Buffer.from(prefix),\n    Buffer.from(prefix, \"utf16le\"), Buffer.from(prefix, \"utf16le\").swap16()]) {\n    if (bytes.includes(needle)) throw new Error(\"CAPTURE_HOST_PATH\");\n  }\n};\nconst recipe = readBounded(import.meta.filename, 64 * 1024);\nassertPrivatePathFree(recipe);\nif (Bun.version !== \"1.3.14\" || (lstatSync(import.meta.dir).mode & 0o777) !== 0o700) {\n  throw new Error(\"CAPTURE_RUNTIME_OR_DIRECTORY_MISMATCH\");\n}\nconst dependencies = {\"@openai/codex\":\"0.149.0\",\"convex\":\"1.45.0\",\"zod\":\"4.4.3\"} as const;\nconst dependencyManifestHashes: Readonly<Record<string,string>> = {\"@openai/codex\":\"0580493a92b83d962b8fdc8585a66c963431c6ddb54fabe4b3797970095f000d\",\"convex\":\"aa9f5baee26b69a88d6b61180e540cce1f52baa31094e7124c8c0393e4b3211e\",\"zod\":\"c630bd10b52dcf71c112a2bf78dbf2734b9db58d62de663b8d86c2ec2c8cda2e\"};\nconst sources = {\n  \"canonical10\": {\n    \"commit\": \"42d91955132816626ce35ae8afc4bc330ba38170\",\n    \"tree\": \"b6c160d105787df4014b149503fbda82ec8835df\",\n    \"sourceFileCount\": 119,\n    \"manifest\": \"37971033b9487826b2d3bb379f8c63593c419b0a9a69473fea9bf372b8ef3406\",\n    \"pins\": {\n      \"src/storage/state-store.ts\": \"6cdee2a6cc9f45f47388169611788f997bce0fe640fa61b9c124785f36d5960e\",\n      \"package.json\": \"4ea731562dba841f3c28b0d899d2b91e14353d4b2fc867a70d8e8ccf5670c00d\",\n      \"bun.lock\": \"650f295c061c3573d0fb4b5542f12977d8e4b5ab8b65d1e019b290f4a205011d\"\n    }\n  }\n} as const;\nconst verifySources = () => {\n  for (const [name, source] of Object.entries(sources)) {\n    const root = join(import.meta.dir, name);\n    for (const [path, expected] of Object.entries(source.pins)) {\n      if (sha256(readBounded(join(root, path))) !== expected) throw new Error(\"CAPTURE_SOURCE_MISMATCH\");\n    }\n    const files: { path: string; sha256: string }[] = [];\n    const visit = (directory: string) => {\n      for (const entry of readdirSync(directory, { withFileTypes: true })) {\n        if (!/^[A-Za-z0-9_.-]+$/u.test(entry.name)) throw new Error(\"CAPTURE_SOURCE_ENTRY_INVALID\");\n        const path = join(directory, entry.name);\n        if (entry.isDirectory()) visit(path);\n        else if (entry.isFile()) files.push({ path: relative(root, path), sha256: sha256(readBounded(path)) });\n        else throw new Error(\"CAPTURE_SOURCE_ENTRY_INVALID\");\n      }\n    };\n    visit(join(root, \"src\"));\n    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);\n    if (files.length !== source.sourceFileCount || sha256(JSON.stringify(files)) !== source.manifest) throw new Error(\"CAPTURE_SOURCE_MANIFEST_MISMATCH\");\n    const declared = z.object({ dependencies: z.record(z.string(), z.string()) }).passthrough()\n      .parse(JSON.parse(readBounded(join(root, \"package.json\")).toString(\"utf8\")));\n    if (JSON.stringify(declared.dependencies) !== JSON.stringify(dependencies)) throw new Error(\"CAPTURE_DEPENDENCIES_MISMATCH\");\n    for (const [dependency, version] of Object.entries(dependencies)) {\n      const manifest = readBounded(join(root, \"node_modules\", dependency, \"package.json\"), 256 * 1024);\n      if (sha256(manifest) !== dependencyManifestHashes[dependency]) throw new Error(\"CAPTURE_DEPENDENCY_MANIFEST_MISMATCH\");\n      z.object({ name: z.literal(dependency), version: z.literal(version) }).passthrough().parse(JSON.parse(manifest.toString(\"utf8\")));\n    }\n  }\n};\nverifySources();\nconst { StateStore } = await import(\"./canonical10/src/storage/state-store\");\nconst { initializeStatePaths, resolveStatePaths } = await import(\"./canonical10/src/storage/paths\");\nconst quote = (value: string) => {\n  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new Error(\"CAPTURE_SQL_IDENTIFIER_INVALID\");\n  return `\"${value}\"`;\n};\nconst snapshot = (db: Database) => {\n  const schema = z.object({ type: z.string(), name: z.string(), tbl_name: z.string(), sql: z.string().nullable() }).strict().array().max(2048)\n    .parse(db.query(\"SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name LIMIT 2049\").all());\n  const tables = schema.filter((row) => row.type === \"table\");\n  if (tables.length > 256) throw new Error(\"CAPTURE_TABLE_LIMIT\");\n  const rows = Object.fromEntries(tables.map(({ name }) => {\n    const entries = db.query(`SELECT * FROM ${quote(name)} LIMIT 4097`).all();\n    if (entries.length > 4096) throw new Error(\"CAPTURE_ROW_LIMIT\");\n    entries.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);\n    return [name, entries];\n  }));\n  const value = { version: db.query(\"PRAGMA user_version\").get(),\n    ledger: db.query(\"SELECT * FROM migrations ORDER BY version\").all(),\n    foreignKeys: db.query(\"PRAGMA foreign_key_check\").all(), schema, rows };\n  if (value.foreignKeys.length !== 0 || Buffer.byteLength(JSON.stringify(value)) > 8 * 1024 * 1024) throw new Error(\"CAPTURE_SNAPSHOT_INVALID\");\n  return value;\n};\nconst inspect = (path: string) => {\n  const db = new Database(path, { create: false, strict: true });\n  try {\n    db.exec(\"PRAGMA query_only=ON\");\n    const result = db.transaction(() => snapshot(db)).deferred();\n    z.object({ n: z.literal(0) }).strict().parse(db.query(\"SELECT total_changes() AS n\").get());\n    return result;\n  } finally { db.close(false); }\n};\nconst checkpoint = (path: string) => {\n  const db = new Database(path, { create: false, strict: true });\n  try { z.object({ busy: z.literal(0), log: z.literal(0), checkpointed: z.literal(0) }).strict()\n    .parse(db.query(\"PRAGMA wal_checkpoint(TRUNCATE)\").get()); } finally { db.close(false); }\n};\n\nconst output = join(import.meta.dir, \"capture\");\nawait mkdir(output, { mode: 0o700 });\nconst paths = resolveStatePaths({ homeDirectory: join(output, \"home10\"), platform: \"darwin\" });\nawait initializeStatePaths(paths);\nconst marker = \"PRAGMA user_version = 2\";\nconst originalSource = readBounded(join(import.meta.dir, \"canonical10/src/storage/state-store.ts\")).toString(\"utf8\");\nif (originalSource.split('database.exec(\"' + marker + '\");').length !== 2) throw new Error(\"CAPTURE_MARKER_INVALID\");\ntype ExecMethod = (this: Database, ...args: Parameters<Database[\"exec\"]>) => ReturnType<Database[\"exec\"]>;\nconst descriptor: (Omit<PropertyDescriptor, \"value\"> & { value?: ExecMethod }) | undefined =\n  Object.getOwnPropertyDescriptor(Database.prototype, \"exec\");\nif (descriptor?.value === undefined || descriptor.configurable !== true) throw new Error(\"CAPTURE_DESCRIPTOR_INVALID\");\nlet observed: { bytes: Buffer; sha256: string; snapshot: ReturnType<typeof snapshot> } | undefined;\nObject.defineProperty(Database.prototype, \"exec\", { ...descriptor,\n  value: function(this: Database, ...args: Parameters<Database[\"exec\"]>) {\n    if (descriptor.value === undefined) throw new Error(\"CAPTURE_DESCRIPTOR_LOST\");\n    const result = descriptor.value.call(this, ...args);\n    if (args[0] === marker) {\n      if (this.filename !== paths.database || !this.inTransaction || observed !== undefined) throw new Error(\"CAPTURE_OBSERVER_TARGET_INVALID\");\n      const before = this.query(\"SELECT total_changes() AS count\").get();\n      const snap = snapshot(this);\n      if (JSON.stringify(snap.version) !== '{\"user_version\":2}'\n        || JSON.stringify(snap.ledger) !== '[{\"version\":1,\"applied_at\":10001},{\"version\":2,\"applied_at\":10001}]'\n        || snap.rows.profiles?.length !== 0 || snap.rows.sessions?.length !== 0\n        || snap.schema.some((row) => row.name === \"desktop_switch_authority\")) throw new Error(\"CAPTURE_EARLY_STAGE_INVALID\");\n      const bytes = Buffer.from(this.serialize());\n      if (bytes.length > 8 * 1024 * 1024\n        || JSON.stringify(this.query(\"SELECT total_changes() AS count\").get()) !== JSON.stringify(before)\n        || !this.inTransaction) throw new Error(\"CAPTURE_OBSERVER_CHANGED_TRANSACTION\");\n      observed = { bytes, sha256: sha256(bytes), snapshot: snap };\n    }\n    return result;\n  } });\nlet store: InstanceType<typeof StateStore>;\ntry { store = new StateStore(paths, { now: () => 10001 }); }\nfinally { Object.defineProperty(Database.prototype, \"exec\", descriptor); }\nstore.close();\nif (Object.getOwnPropertyDescriptor(Database.prototype, \"exec\")?.value !== descriptor.value\n  || observed === undefined || sha256(observed.bytes) !== observed.sha256) throw new Error(\"CAPTURE_OBSERVER_RESTORE_INVALID\");\ncheckpoint(paths.database);\nconst completed = inspect(paths.database);\nif (JSON.stringify(completed.version) !== '{\"user_version\":10}'\n  || JSON.stringify(completed.ledger) !== JSON.stringify(Array.from({ length: 10 }, (_, index) =>\n    ({ version: index + 1, applied_at: 10001 })))) throw new Error(\"CAPTURE_FINAL_LEDGER_INVALID\");\nfor (const readonly of [false, true]) {\n  const before = readBounded(paths.database);\n  const reopened = new StateStore(paths, { readonly, now: () => 10002 });\n  reopened.close();\n  if (JSON.stringify(inspect(paths.database)) !== JSON.stringify(completed)) throw new Error(\"CAPTURE_FINAL_REOPEN_CHANGED\");\n  checkpoint(paths.database);\n  if (readonly && sha256(readBounded(paths.database)) !== sha256(before)) throw new Error(\"CAPTURE_FINAL_READONLY_BYTES_CHANGED\");\n}\nconst stagePath = join(output, \"observed2-empty.sqlite\");\nassertPrivatePathFree(observed.bytes);\nawait writeFile(stagePath, observed.bytes, { mode: 0o600, flag: \"wx\" });\nif (JSON.stringify(inspect(stagePath)) !== JSON.stringify(observed.snapshot)\n  || sha256(readBounded(stagePath)) !== observed.sha256) throw new Error(\"CAPTURE_STAGE_STANDALONE_CHANGED\");\nverifySources();\nif (sha256(readBounded(import.meta.filename, 64 * 1024)) !== sha256(recipe)) throw new Error(\"CAPTURE_RECIPE_CHANGED\");\nconst metadata = { generatorSha256: sha256(recipe), bunVersion: Bun.version, sources,\n  dependencies, dependencyManifestHashes, schemaVersion: 2,\n  databaseSha256: observed.sha256, databaseBytes: observed.bytes.length, snapshot: observed.snapshot,\n  final10SnapshotSha256: sha256(JSON.stringify(completed)),\n  provenance: { kind: \"uncommitted_archived_migration_stage\", releasedWriterImage: false,\n    marker, observedBeforeOuterCommit: true, observerRowOrSchemaWrites: false,\n    originalProfilesAndSessionsEmpty: true, standaloneSnapshotAndBytesUnchanged: true,\n    final10WritableAndReadonlyReopensUnchanged: true, final10ReadonlyBytesUnchanged: true,\n    providerEffects: 0, sourceAndDependenciesReverifiedAfterUse: true } };\nconst bytes = Buffer.from(JSON.stringify(metadata, null, 2) + \"\\n\");\nif (bytes.length > 16 * 1024 * 1024) throw new Error(\"CAPTURE_METADATA_LIMIT\");\nassertPrivatePathFree(bytes);\nawait writeFile(join(output, \"fixture.json\"), bytes, { mode: 0o600, flag: \"wx\" });\nconsole.log(JSON.stringify({ generatorSha256: metadata.generatorSha256,\n  databaseSha256: metadata.databaseSha256, databaseBytes: metadata.databaseBytes }));\n";

const compressed = {
  "single": {
    "gzipSha256": "a41d45b74a2e71ef26b7c9be3c9525bea522a43ecba3d365356a47b0d287882a",
    "base64": "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"
  }
} as const;

export function observed2DatabaseBytes(): Buffer {
  const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
  if (digest(Buffer.from(observed2GeneratorSource)) !== observed2Fixture.generatorSha256) throw new Error("HISTORICAL_RECIPE_MISMATCH");
  const stored = compressed["single"];
  const packed = Buffer.from(stored.base64, "base64");
  if (digest(packed) !== stored.gzipSha256) throw new Error("HISTORICAL_GZIP_MISMATCH");
  const bytes = gunzipSync(packed, { maxOutputLength: 8 * 1024 * 1024 });
  const expected = observed2Fixture;
  if (bytes.length !== expected.databaseBytes || digest(bytes) !== expected.databaseSha256) throw new Error("HISTORICAL_IMAGE_MISMATCH");
  return bytes;
}
