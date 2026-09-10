import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

// Generated exclusively through StateStore APIs archived at exact canonical
// 95f1fdd107a64553faaefb12f1e9d8b5c9e246ca. No historical DDL or rows were edited.
export const canonical24ResetFixture = {
  "sourceRevision": "95f1fdd107a64553faaefb12f1e9d8b5c9e246ca",
  "schemaVersion": 24,
  "databaseSha256": "c90cb1d200be4c22f94f4b9b1bf65c9c4bda2ddfd994dabefbf8bbc99409454b",
  "databaseBytes": 421888,
  "generatorSha256": "f9e28ef987bf1b4bb1ac259fd61fcc86be0470df922081169c86691a7bf96e10",
  "now": 3000000000,
  "bootId": "boot_22222222222222222222222222222222",
  "daemonGeneration": 1,
  "profile": {
    "id": "acct_01d381c81ae448afb11cd901b9c30c81",
    "label": "V24 reset reconciliation",
    "state": "signed_in",
    "processGeneration": 1,
    "providerEmail": "person@example.com",
    "providerPlan": "Plus",
    "createdAt": 3000000000,
    "updatedAt": 3000000000
  },
  "profileRow": {
    "id": "acct_01d381c81ae448afb11cd901b9c30c81",
    "label": "V24 reset reconciliation",
    "state": "signed_in",
    "process_generation": 1,
    "provider_email": "person@example.com",
    "provider_plan": "Plus",
    "created_at": 3000000000,
    "updated_at": 3000000000,
    "label_key": "v24 reset reconciliation"
  },
  "migrations": [
    {
      "version": 1,
      "applied_at": 3000000000
    },
    {
      "version": 2,
      "applied_at": 3000000000
    },
    {
      "version": 3,
      "applied_at": 3000000000
    },
    {
      "version": 4,
      "applied_at": 3000000000
    },
    {
      "version": 5,
      "applied_at": 3000000000
    },
    {
      "version": 6,
      "applied_at": 3000000000
    },
    {
      "version": 7,
      "applied_at": 3000000000
    },
    {
      "version": 8,
      "applied_at": 3000000000
    },
    {
      "version": 9,
      "applied_at": 3000000000
    },
    {
      "version": 10,
      "applied_at": 3000000000
    },
    {
      "version": 11,
      "applied_at": 3000000000
    },
    {
      "version": 12,
      "applied_at": 3000000000
    },
    {
      "version": 13,
      "applied_at": 3000000000
    },
    {
      "version": 14,
      "applied_at": 3000000000
    },
    {
      "version": 15,
      "applied_at": 3000000000
    },
    {
      "version": 16,
      "applied_at": 3000000000
    },
    {
      "version": 17,
      "applied_at": 3000000000
    },
    {
      "version": 18,
      "applied_at": 3000000000
    },
    {
      "version": 19,
      "applied_at": 3000000000
    },
    {
      "version": 20,
      "applied_at": 3000000000
    },
    {
      "version": 21,
      "applied_at": 3000000000
    },
    {
      "version": 22,
      "applied_at": 3000000000
    },
    {
      "version": 23,
      "applied_at": 3000000000
    },
    {
      "version": 24,
      "applied_at": 3000000000
    }
  ]
} as const;

export const canonical24ResetFixtureGeneratorSource = "import { createHash } from \"node:crypto\";\nimport { readFile } from \"node:fs/promises\";\nimport { gzipSync } from \"node:zlib\";\nimport { Database } from \"bun:sqlite\";\nimport { StateStore } from \"./src/storage/state-store\";\nimport { initializeStatePaths, resolveStatePaths } from \"./src/storage/paths\";\n\nconst now = 3_000_000_000;\nconst paths = resolveStatePaths({ homeDirectory: `${import.meta.dir}/fixture-home`, platform: \"darwin\" });\nawait initializeStatePaths(paths);\nconst store = new StateStore(paths, { now: () => now });\nconst bootId = `boot_${\"2\".repeat(32)}`;\nconst daemonGeneration = store.nextDaemonGeneration(bootId);\nconst profile = store.nextProfileGeneration(store.createProfile(\"V24 reset reconciliation\").id);\nif (!store.setProfileState(profile.id, profile.processGeneration, \"signed_in\", {\n  email: \"person@example.com\",\n  plan: \"Plus\",\n})) throw new Error(\"Archived sign-in failed.\");\nconst signedIn = store.requireProfileById(profile.id);\nstore.close();\nconst database = new Database(paths.database);\ndatabase.exec(\"PRAGMA wal_checkpoint(TRUNCATE)\");\nconst version = database.query(\"PRAGMA user_version\").get() as { user_version: number };\nif (version.user_version !== 24) throw new Error(\"Wrong archived schema.\");\nconst migrations = database.query(\"SELECT version,applied_at FROM migrations ORDER BY version\").all();\nconst profileRow = database.query(\"SELECT * FROM profiles WHERE id=?\").get(profile.id);\nif (database.query(\"SELECT name FROM sqlite_master WHERE name='account_rate_limit_reset_policies'\").get() !== null) {\n  throw new Error(\"Archived schema unexpectedly has reset policy state.\");\n}\ndatabase.close();\nconst bytes = await readFile(paths.database);\nconst source = await readFile(import.meta.filename, \"utf8\");\nconst meta = {\n  sourceRevision: \"95f1fdd107a64553faaefb12f1e9d8b5c9e246ca\",\n  schemaVersion: 24,\n  databaseSha256: createHash(\"sha256\").update(bytes).digest(\"hex\"),\n  databaseBytes: bytes.length,\n  generatorSha256: createHash(\"sha256\").update(source).digest(\"hex\"),\n  now,\n  bootId,\n  daemonGeneration,\n  profile: signedIn,\n  profileRow,\n  migrations,\n};\nconsole.log(JSON.stringify({ meta, source, gzip: gzipSync(bytes).toString(\"base64\") }));\n";

const encoded = [
  "H4sIAAAAAAAAE+2de4wbSX7fm3oMKerBvSd3PV5fybt3HN5S2qGk1eycltrjzLQknkbkiuSctCfr+nq6azi9Irup7uasZDt34Ei7exs/4rv8EcOx/0hiIIGR",
  "BxDDsYHgEjiJYfgPG0lswHk4cBBc4iAxEARGYseGk6Cr381ukjOSVj7q+xGgIbt+9at3dTWr6/drXV9XTEq2NL0nmuQs9xx34AD3RUI4jjvAcVyH8/k1juMO",
  "Bb6nOI57nhvPAe70T/zJYY7jTuR+2freyf1Z7n/n/mfuD3N/kPtPuf+Q+63cv8n9du43cv889x1bAAAAAAAAAAAAAEGk4Sscx90evsRx3K2h9Yx94+scx619",
  "meO4L5scx32Jchz3xSbHcctXOY4r8xzHff51juN+sGQ9ub/IcdynnztuqXoONQsAAAAAAAAAAMwy1vP/8yf+hMv9r9x/y/1+7ndyv5H7J7lfzP2d3M/lvp37",
  "IPejubu5rdyt3Fs5PveF3Ku5l3Mv5E7kDp74k6edbwAAAAAAAAAAYBqOPH+QO8xx//BffpU7kvc/ftr/+Cn/4yf9j5/wP37c//gx/+Nz/sec//GE//G4//GY",
  "//Go/zHrfzzif8z4H9P+xzn/42H/4yH/40H/4wH/Y8r7aD3/p3K/yeV+E/0GAAAAAAAAAAD4nqCcmuOO3DjMbWqaKZyZQPD53+ByxtPOPAAAAAAAAAAAMFMM",
  "s6nsjcpnjpQ/dfhwRZQkU1gsy2dfL0uvl0V67tzr4tZmuSzJy4vlzWXp7KL0evnLZ84RnRrUJDqVNFVSuopoKppqKB2VyoKi9qluaOoX6T2x1+/S05LWe6s7",
  "MOwnfPv/nQQVWfb8/7tc7nefdrUAAAAAAAAAAABgjywcvHFkqp8W7Of/73K576KOAQAAAAAAAACA72XmD1aOJO3/w/4/AAAAAAAAAAAw+1j7//D/BwAAAAAA",
  "AAAAzDZ4/gcAAAAAAAAAAGYfPP8DAAAAAAAAAACzD57/AQAAAAAAAACA2Qf2/wAAAAAAAAAAgNkH+/8AAAAAAAAAAMDsg+d/AAAAAAAAAABg9sHzPwAAAAAA",
  "AAAAMPvg/D8AAAAAAAAAADD7YP8fAAAAAAAAAACYffD8DwAAAAAAAAAAzD54/x8AAAAAAAAAAJh9sP8PAAAAAAAAAAA8G/v/z3Hf5k789xPXj3/1wIXjp479",
  "PPftY8axlaP/4ujG3B8efTn7R9mfOnTno8vRg8+l0/kXX0y9/xlT3OzSvq69QyXTcP9mVpt8tc2TdnVlnSfuVbKQJUSRSZu/2SZvNWvXqs23yVX+bbJ6hV+9",
  "uqDI5PJ6Y4UULHnh1uKpZfHU1u3PF0i1vka6VO2Y2wuKXCQVcnapWMoS0hU3adfWVm+0SX1jfd1R5UgzgSJZ4ds3eL5OykxT+fwii61rmin0RXM7omGjXru+",
  "wVsSiiHIdEscdE1Sq7f5y3wzmk5IgiwslspFplvSqWhSWRATYwYkLlaInaNBX54QKyBxsRJIpZgt2bUh3KH3WXmKpNVu1lbbD08dYg31zVNuQ20pXWq4fw9H",
  "G4pdnbahREkyn3xDGaZo0tjYdohV8wVD6ahUFrSBWSgVulpHUYU+VWVF7RRKbqCiFkoFnUraDtXvCzq9O1B0KrNrPW2HygW78fq6JlHDEDpUpbpoKpqa1Bwx",
  "kl5j9nVtR5GpLtCeqNiFD13ud0XVu/oXqL98/bl0vlBIfXiB9Ze7AzqgAlVNXaFG6MvHQj0nFDRt97Ejje0/r9s9gBqGoqmCq9MrZZO/xDf5+irfcmUMFrNR",
  "J2v8Ot/myWq1tVpdY8O5Rw1D7MT3JCfV1WqrveDKVVtkZb2xUoz2yzPnz5TPnZu+a/r9UFaMvmhK2/Y3sd/vKqz/bYlKl30Qe5tKZ6ANjEKpIImqRLvW9ac3",
  "p1DVbiPD6giqRD0ddtTR4JatudEcjRquxOXFxaXy8vKZ184tnVtcXl4suh3wg5PH2IT1k59iHdBtVvfv8VC3c69O2+Ms+WkmLGciHNvh3MnSiunEse5yXpyw",
  "KLsBBkTtScDc1qkou1GsIFMxu2O7KBMokjcq5OwZu4lVbaQPrvGXqhvrbVIoxPRvJu937jcqpHz+7Ot2h+7r1KBmbPpOEOvSXe3dQqmwrXS2C6XCoGvqotNJ",
  "t0TDFKhqtZyc1OEiMoHb5nQzvSnqpjOCJFPZoYVSQZG71h+T6j1FFbux07ydhB1FMAe6N52wxQDdUayelJRnL/yiM64+8tFY8ntNQKbJVwM3o5HgwHiMC/by",
  "Za95FvxuX4rpo8WsO0bFXDr/youpYVpRZXrPHYSCTiWqmu7X55yRWquv8TdJRMiaob0ZO5CjNb61WiKKXHz1xFx+9cUUZ6dwt6uYVBAHpsa+C562M+6n3KvH",
  "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",
  "/wFgMey3AHAGAA==",
].join("");

export function canonical24ResetDatabaseBytes(): Uint8Array {
  const bytes = gunzipSync(Buffer.from(encoded, "base64"));
  if (bytes.byteLength !== canonical24ResetFixture.databaseBytes
    || createHash("sha256").update(bytes).digest("hex") !== canonical24ResetFixture.databaseSha256
    || createHash("sha256").update(canonical24ResetFixtureGeneratorSource).digest("hex") !== canonical24ResetFixture.generatorSha256) {
    throw new Error("CANONICAL24_RESET_FIXTURE_INVALID");
  }
  return new Uint8Array(bytes);
}
