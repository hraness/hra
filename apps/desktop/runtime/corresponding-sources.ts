import { createHash } from "node:crypto";
import {
  lstat,
  lutimes,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

export type CorrespondingSourceSubmodule = Readonly<{
  archiveName?: string;
  commit: string;
  minimumEntries?: number;
  path: string;
  repository: string;
  sentinels?: readonly string[];
}>;

type BunSourceDeclaration = Readonly<{
  path: string;
  sha256: string;
}>;

export type CorrespondingSourceExternalGit = Readonly<{
  archivePath: string;
  cargoVendor?: Readonly<{
    checksumManifestSha256: string;
    configPath: string;
    lockPath: string;
    lockSha256: string;
    packageCount: number;
    path: string;
  }>;
  commit: string;
  declaration: BunSourceDeclaration;
  declaredRevision: string;
  gitmodulesSha256?: string;
  kind: "git";
  minimumEntries: number;
  project: string;
  repository: string;
  sentinels: readonly string[];
  submodules: readonly CorrespondingSourceSubmodule[];
}>;

export type CorrespondingSourceExternalArchive = Readonly<{
  archivePath: string;
  declaration: BunSourceDeclaration;
  kind: "archive";
  minimumEntries: number;
  project: string;
  sentinels: readonly string[];
  sha256: string;
  sourceArchivePrefix: string;
  url: string;
}>;

export type CorrespondingSourceExternalLink = Readonly<{
  archiveName: string;
  commit: string;
  declaration: BunSourceDeclaration;
  kind: "linked-archive";
  project: string;
  repository: string;
}>;

export type CorrespondingSourceExternal =
  | CorrespondingSourceExternalArchive
  | CorrespondingSourceExternalGit
  | CorrespondingSourceExternalLink;

export type CorrespondingSourceSpec = Readonly<{
  archiveName: string;
  archivePrefix: string;
  commit: string;
  minimumEntries: number;
  project: string;
  repository: string;
  sentinels: readonly string[];
  submodules: readonly CorrespondingSourceSubmodule[];
  externalSources: readonly CorrespondingSourceExternal[];
  gitmodulesSha256?: string;
}>;

export type CorrespondingSourceEvidence = Readonly<{
  archiveName: string;
  bytes: number;
  commit: string;
  project: string;
  repository: string;
  sha256: string;
  submodules: readonly CorrespondingSourceSubmodule[];
  externalSources: readonly CorrespondingSourceExternal[];
}>;

const sourceManifestName = "HRA-CORRESPONDING-SOURCE-MANIFEST.json";
const githubReleaseAssetByteLimit = 2 * 1024 * 1024 * 1024;

const bunExternalSourceSpecs = Object.freeze([
  {
    archivePath: "HRA-EXTERNAL-SOURCES/boringssl-0c5fce43b7ed5eb6001487ee48ac65766f5ddcd1",
    commit: "0c5fce43b7ed5eb6001487ee48ac65766f5ddcd1",
    declaration: { path: "scripts/build/deps/boringssl.ts", sha256: "13ce2c8c52282ce6ae566f0a4ea55600adb50177d0873a6c50be02f09ead8b4e" },
    declaredRevision: "0c5fce43b7ed5eb6001487ee48ac65766f5ddcd1",
    kind: "git",
    minimumEntries: 1_000,
    project: "BoringSSL",
    repository: "https://github.com/oven-sh/boringssl.git",
    sentinels: ["LICENSE", "crypto/fipsmodule/bcm.cc", "include/openssl/ssl.h"],
    submodules: [],
  },
  {
    archivePath: "HRA-EXTERNAL-SOURCES/brotli-ed738e842d2fbdf2d6459e39267a633c4a9b2f5d",
    commit: "ed738e842d2fbdf2d6459e39267a633c4a9b2f5d",
    declaration: { path: "scripts/build/deps/brotli.ts", sha256: "3cfcb60f9b95982dd73c8280e17226b1aa8d4823df65878a82a5136cb4bb60a6" },
    declaredRevision: "v1.1.0",
    kind: "git",
    minimumEntries: 140,
    project: "Brotli",
    repository: "https://github.com/google/brotli.git",
    sentinels: ["LICENSE", "c/dec/decode.c", "c/include/brotli/decode.h"],
    submodules: [],
  },
  {
    archivePath: "HRA-EXTERNAL-SOURCES/c-ares-3ac47ee46edd8ea40370222f91613fc16c434853",
    commit: "3ac47ee46edd8ea40370222f91613fc16c434853",
    declaration: { path: "scripts/build/deps/cares.ts", sha256: "02c2f9b30972c764dcc4d8cfbff19ea554e24ac0fc72074a963dee2d67346efd" },
    declaredRevision: "3ac47ee46edd8ea40370222f91613fc16c434853",
    kind: "git",
    minimumEntries: 500,
    project: "c-ares",
    repository: "https://github.com/c-ares/c-ares.git",
    sentinels: ["LICENSE.md", "include/ares.h", "src/lib/ares_init.c"],
    submodules: [],
  },
  {
    archivePath: "HRA-EXTERNAL-SOURCES/hdrhistogram-be60a9987ee48d0abf0d7b6a175bad8d6c1585d1",
    commit: "be60a9987ee48d0abf0d7b6a175bad8d6c1585d1",
    declaration: { path: "scripts/build/deps/hdrhistogram.ts", sha256: "5f50be6a4f57d7ec957dd082641c75ed487ffea587acadadabfe281c4f02bca1" },
    declaredRevision: "be60a9987ee48d0abf0d7b6a175bad8d6c1585d1",
    gitmodulesSha256: "3b8b2840757a09dfefdd43c2f80e20d971824178c64da26203f77ce8cf713e87",
    kind: "git",
    minimumEntries: 50,
    project: "HdrHistogram_c",
    repository: "https://github.com/HdrHistogram/HdrHistogram_c.git",
    sentinels: ["LICENSE.txt", "src/hdr_histogram.c", "include/hdr/hdr_histogram.h"],
    submodules: [
      {
        commit: "daff5fead3fbe22c6fc58310ca3f49caf117f185",
        minimumEntries: 140,
        path: "test/vendor/google/benchmark",
        repository: "https://github.com/google/benchmark.git",
        sentinels: ["LICENSE", "include/benchmark/benchmark.h", "src/benchmark.cc"],
      },
    ],
  },
  {
    archivePath: "HRA-EXTERNAL-SOURCES/highway-2607d3b5b0113992fe84d3848859eae13b3b52c1",
    commit: "2607d3b5b0113992fe84d3848859eae13b3b52c1",
    declaration: { path: "scripts/build/deps/highway.ts", sha256: "19df0b66c34bf5b24977b47f3e9ef702dfe5d359cd662a87449a628fa10db1d1" },
    declaredRevision: "2607d3b5b0113992fe84d3848859eae13b3b52c1",
    kind: "git",
    minimumEntries: 300,
    project: "Highway",
    repository: "https://github.com/google/highway.git",
    sentinels: ["LICENSE", "hwy/highway.h", "hwy/targets.cc"],
    submodules: [],
  },
  {
    archivePath: "HRA-EXTERNAL-SOURCES/libarchive-ded82291ab41d5e355831b96b0e1ff49e24d8939",
    commit: "ded82291ab41d5e355831b96b0e1ff49e24d8939",
    declaration: { path: "scripts/build/deps/libarchive.ts", sha256: "3625b85a96df03c674f2e6e6664cb4debed6138f7a271cf223e6b0feb47e1a55" },
    declaredRevision: "ded82291ab41d5e355831b96b0e1ff49e24d8939",
    kind: "git",
    minimumEntries: 1_300,
    project: "libarchive",
    repository: "https://github.com/libarchive/libarchive.git",
    sentinels: ["COPYING", "libarchive/archive_read.c", "libarchive/archive.h"],
    submodules: [],
  },
  {
    archivePath: "HRA-EXTERNAL-SOURCES/libdeflate-c8c56a20f8f621e6a966b716b31f1dedab6a41e3",
    commit: "c8c56a20f8f621e6a966b716b31f1dedab6a41e3",
    declaration: { path: "scripts/build/deps/libdeflate.ts", sha256: "a5579e22a93158eebe9e646ef9200ad738944af3194ddfced67f00b5fdba76c5" },
    declaredRevision: "c8c56a20f8f621e6a966b716b31f1dedab6a41e3",
    kind: "git",
    minimumEntries: 100,
    project: "libdeflate",
    repository: "https://github.com/ebiggers/libdeflate.git",
    sentinels: ["COPYING", "lib/deflate_compress.c", "libdeflate.h"],
    submodules: [],
  },
  {
    archivePath: "HRA-EXTERNAL-SOURCES/libjpeg-turbo-e352b02f794f701407b39af08576035ba3360d60",
    commit: "e352b02f794f701407b39af08576035ba3360d60",
    declaration: { path: "scripts/build/deps/libjpeg-turbo.ts", sha256: "cc7f4de3324bca7b32455c206f3b730c00ff23e0bf44ef2f110ed49a2a7bf9d9" },
    declaredRevision: "e352b02f794f701407b39af08576035ba3360d60",
    kind: "git",
    minimumEntries: 500,
    project: "libjpeg-turbo",
    repository: "https://github.com/libjpeg-turbo/libjpeg-turbo.git",
    sentinels: ["LICENSE.md", "src/jcapimin.c", "src/jpeglib.h"],
    submodules: [],
  },
  {
    archivePath: "HRA-EXTERNAL-SOURCES/libspng-fb768002d4288590083a476af628e51c3f1d47cd",
    commit: "fb768002d4288590083a476af628e51c3f1d47cd",
    declaration: { path: "scripts/build/deps/libspng.ts", sha256: "74217c1bc88d817b0c3c95cae154c3cb3382dad6e1c09ef9966708393738705a" },
    declaredRevision: "fb768002d4288590083a476af628e51c3f1d47cd",
    kind: "git",
    minimumEntries: 50,
    project: "libspng",
    repository: "https://github.com/randy408/libspng.git",
    sentinels: ["LICENSE", "spng/spng.c", "spng/spng.h"],
    submodules: [],
  },
  {
    archivePath: "HRA-EXTERNAL-SOURCES/libwebp-4fa21912338357f89e4fd51cf2368325b59e9bd9",
    commit: "4fa21912338357f89e4fd51cf2368325b59e9bd9",
    declaration: { path: "scripts/build/deps/libwebp.ts", sha256: "54ad45eea96dc3ad8a021b27377709e383ae43c5864506eaea7e4baf1a677da7" },
    declaredRevision: "b7e29b9d75bd31422b00c2a446d49d7af06c328d",
    kind: "git",
    minimumEntries: 350,
    project: "libwebp",
    repository: "https://github.com/webmproject/libwebp.git",
    sentinels: ["COPYING", "src/dec/webp_dec.c", "src/webp/decode.h"],
    submodules: [],
  },
  {
    archivePath: "HRA-EXTERNAL-SOURCES/lol-html-77127cd2b8545998756e8d64e36ee2313c4bb312",
    cargoVendor: {
      checksumManifestSha256: "95e5340bab553e38501ed93da701ed9e9fd1a09af158e6f713298cda596aded7",
      configPath: "HRA-CARGO-CONFIG.toml",
      lockPath: "c-api/Cargo.lock",
      lockSha256: "02d28352293be00f05be457e59e60d5b9d7e84a4cdc43bd40236a12bf8d1e53d",
      packageCount: 43,
      path: "HRA-CARGO-VENDOR",
    },
    commit: "77127cd2b8545998756e8d64e36ee2313c4bb312",
    declaration: { path: "scripts/build/deps/lolhtml.ts", sha256: "cc1342c71a6cc249a1b7731434a75e551e27f13739bd6c854ac1e8074c2cb9fe" },
    declaredRevision: "77127cd2b8545998756e8d64e36ee2313c4bb312",
    gitmodulesSha256: "3c8e90bec412754c0cd80997d8eacfe0f2280c6c57160e5c4d3b04f06c09cbf6",
    kind: "git",
    minimumEntries: 400,
    project: "lol-html",
    repository: "https://github.com/cloudflare/lol-html.git",
    sentinels: ["LICENSE", "c-api/Cargo.toml", "c-api/Cargo.lock"],
    submodules: [
      {
        commit: "f994590f528ac8b6073665791ddb1ed85c66dfb2",
        minimumEntries: 100,
        path: "tests/data/html5lib-tests",
        repository: "https://github.com/html5lib/html5lib-tests.git",
        sentinels: ["LICENSE", "tokenizer/test1.test", "tree-construction/tests1.dat"],
      },
    ],
  },
  {
    archivePath: "HRA-EXTERNAL-SOURCES/ls-hpack-8905c024b6d052f083a3d11d0a169b3c2735c8a1",
    commit: "8905c024b6d052f083a3d11d0a169b3c2735c8a1",
    declaration: { path: "scripts/build/deps/lshpack.ts", sha256: "d40711b116f4747f86a2ab84e26ad147aded41d837bb3385729bc92d46d134c3" },
    declaredRevision: "8905c024b6d052f083a3d11d0a169b3c2735c8a1",
    kind: "git",
    minimumEntries: 30,
    project: "ls-hpack",
    repository: "https://github.com/litespeedtech/ls-hpack.git",
    sentinels: ["LICENSE", "lshpack.c", "lshpack.h"],
    submodules: [],
  },
  {
    archivePath: "HRA-EXTERNAL-SOURCES/ls-qpack-1e9c5b8e59f8161c54f168a570c8bfdc59ded0c3",
    commit: "1e9c5b8e59f8161c54f168a570c8bfdc59ded0c3",
    declaration: { path: "scripts/build/deps/lsqpack.ts", sha256: "5759a9e4111e4aaf84e6ad2fc4040500e0a6b06ab8471ed95ea048447f704317" },
    declaredRevision: "1e9c5b8e59f8161c54f168a570c8bfdc59ded0c3",
    kind: "git",
    minimumEntries: 50,
    project: "ls-qpack",
    repository: "https://github.com/litespeedtech/ls-qpack.git",
    sentinels: ["LICENSE", "lsqpack.c", "lsqpack.h"],
    submodules: [],
  },
  {
    archivePath: "HRA-EXTERNAL-SOURCES/lsquic-3181911301b1aa4f54c1ed690901abc674ee08fb",
    commit: "3181911301b1aa4f54c1ed690901abc674ee08fb",
    declaration: { path: "scripts/build/deps/lsquic.ts", sha256: "4ca0682970a1e2076484a0055a279dd3643497a1e1c49af50a13064a0fd16677" },
    declaredRevision: "3181911301b1aa4f54c1ed690901abc674ee08fb",
    gitmodulesSha256: "3d0821186a415fa74ea88ac072e81dc4c651678afe4fb2bfa38ee2a0e1a8bd0d",
    kind: "git",
    minimumEntries: 450,
    project: "lsquic",
    repository: "https://github.com/litespeedtech/lsquic.git",
    sentinels: ["LICENSE", "LICENSE.chrome", "src/liblsquic/lsquic_engine.c"],
    submodules: [
      {
        commit: "1a27f87ece031f9e2fbfb29d5b3ef0a72e0a6bbb",
        minimumEntries: 70,
        path: "src/liblsquic/ls-qpack",
        repository: "https://github.com/litespeedtech/ls-qpack.git",
        sentinels: ["LICENSE", "lsqpack.c", "lsqpack.h"],
      },
      {
        commit: "8905c024b6d052f083a3d11d0a169b3c2735c8a1",
        minimumEntries: 30,
        path: "src/lshpack",
        repository: "https://github.com/litespeedtech/ls-hpack.git",
        sentinels: ["LICENSE", "lshpack.c", "lshpack.h"],
      },
    ],
  },
  {
    archivePath: "HRA-EXTERNAL-SOURCES/mimalloc-f15aecb94fc8096008bf87b90c53ed682026914a",
    commit: "f15aecb94fc8096008bf87b90c53ed682026914a",
    declaration: { path: "scripts/build/deps/mimalloc.ts", sha256: "4629d67ca526d2fc113055e0b8caccd7561193736bdcc9d39a36f57461753531" },
    declaredRevision: "f15aecb94fc8096008bf87b90c53ed682026914a",
    kind: "git",
    minimumEntries: 200,
    project: "mimalloc",
    repository: "https://github.com/oven-sh/mimalloc.git",
    sentinels: ["LICENSE", "include/mimalloc.h", "src/alloc.c"],
    submodules: [],
  },
  {
    archivePath: "HRA-EXTERNAL-SOURCES/picohttpparser-066d2b1e9ab820703db0837a7255d92d30f0c9f5",
    commit: "066d2b1e9ab820703db0837a7255d92d30f0c9f5",
    declaration: { path: "scripts/build/deps/picohttpparser.ts", sha256: "12c3d58955bcecf4084078ab63f35b68cca5b60e568c7241085cd8207a4eb5b6" },
    declaredRevision: "066d2b1e9ab820703db0837a7255d92d30f0c9f5",
    gitmodulesSha256: "572b6883f6513ebce8e5fe73632e30536fffd690d5efaf76f3c9bf7ed2eb4a07",
    kind: "git",
    minimumEntries: 20,
    project: "picohttpparser",
    repository: "https://github.com/h2o/picohttpparser.git",
    sentinels: ["README.md", "picohttpparser.c", "picohttpparser.h"],
    submodules: [
      {
        commit: "70b9797596d81896cba49e5918fd5b1edf57269b",
        minimumEntries: 2,
        path: "picotest",
        repository: "https://github.com/h2o/picotest.git",
        sentinels: ["picotest.c", "picotest.h"],
      },
    ],
  },
  {
    archivePath: "HRA-EXTERNAL-SOURCES/tinycc-12882eee073cfe5c7621bcfadf679e1372d4537b",
    commit: "12882eee073cfe5c7621bcfadf679e1372d4537b",
    declaration: { path: "scripts/build/deps/tinycc.ts", sha256: "322bdc7fdea5c41557aa515985ecdef6f67d59a5f3891de8b9a402e8d7e22500" },
    declaredRevision: "12882eee073cfe5c7621bcfadf679e1372d4537b",
    kind: "git",
    minimumEntries: 300,
    project: "TinyCC",
    repository: "https://github.com/oven-sh/tinycc.git",
    sentinels: ["COPYING", "tcc.c", "tcc.h"],
    submodules: [],
  },
  {
    archivePath: "HRA-EXTERNAL-SOURCES/zlib-ng-12731092979c6d07f42da27da673a9f6c7b13586",
    commit: "12731092979c6d07f42da27da673a9f6c7b13586",
    declaration: { path: "scripts/build/deps/zlib.ts", sha256: "1d240589025ed3a9af56310d35702b1d165013d88ee9afc4815e67f834fb8e8f" },
    declaredRevision: "12731092979c6d07f42da27da673a9f6c7b13586",
    kind: "git",
    minimumEntries: 380,
    project: "zlib-ng",
    repository: "https://github.com/zlib-ng/zlib-ng.git",
    sentinels: ["LICENSE.md", "deflate.c", "zlib.h.in"],
    submodules: [],
  },
  {
    archivePath: "HRA-EXTERNAL-SOURCES/zstd-f8745da6ff1ad1e7bab384bd1f9d742439278e99",
    commit: "f8745da6ff1ad1e7bab384bd1f9d742439278e99",
    declaration: { path: "scripts/build/deps/zstd.ts", sha256: "b4235364eecc40d0f88bd427904a3066cf58535b6fa77d4034a331870786b296" },
    declaredRevision: "f8745da6ff1ad1e7bab384bd1f9d742439278e99",
    kind: "git",
    minimumEntries: 700,
    project: "zstd",
    repository: "https://github.com/facebook/zstd.git",
    sentinels: ["LICENSE", "lib/zstd.h", "lib/compress/zstd_compress.c"],
    submodules: [],
  },
  {
    archivePath: "HRA-EXTERNAL-SOURCES/node-v24.3.0-headers",
    declaration: { path: "scripts/build/deps/nodejs-headers.ts", sha256: "73ff54857b3cfc0dc6ea88be5142e8d7aa490d672fbff7898396f1fddb2d6c13" },
    kind: "archive",
    minimumEntries: 500,
    project: "Node.js headers",
    sentinels: ["include/node/node.h", "include/node/v8.h", "include/node/uv.h"],
    sha256: "045e9bf477cd5db0ec67f8c1a63ba7f784dedfe2c581e3d0ed09b88e9115dd07",
    sourceArchivePrefix: "node-v24.3.0/",
    url: "https://nodejs.org/dist/v24.3.0/node-v24.3.0-headers.tar.gz",
  },
  {
    archiveName: "bun-webkit-5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b-source.tar.gz",
    commit: "5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b",
    declaration: { path: "scripts/build/deps/webkit.ts", sha256: "3e9e0e00dbf04d5396094c25fa07eee2b7f1479dd589197d7f0d7c7ead48f6d3" },
    kind: "linked-archive",
    project: "Bun WebKit",
    repository: "https://github.com/oven-sh/WebKit.git",
  },
] as const satisfies readonly CorrespondingSourceExternal[]);

export const correspondingSourceSpecs = Object.freeze([
  {
    archiveName: "bun-0d9b296af33f2b851fcbf4df3e9ec89751734ba4-source.tar.gz",
    archivePrefix: "bun-0d9b296af33f2b851fcbf4df3e9ec89751734ba4/",
    commit: "0d9b296af33f2b851fcbf4df3e9ec89751734ba4",
    minimumEntries: 10_000,
    project: "Bun",
    repository: "https://github.com/oven-sh/bun.git",
    sentinels: [
      "LICENSE.md",
      "scripts/build/deps/webkit.ts",
      "src/jsc/bindings/BunProcess.cpp",
    ],
    externalSources: bunExternalSourceSpecs,
    submodules: [],
  },
  {
    archiveName: "bun-webkit-5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b-source.tar.gz",
    archivePrefix: "bun-webkit-5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b/",
    commit: "5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b",
    minimumEntries: 50_000,
    project: "Bun WebKit",
    repository: "https://github.com/oven-sh/WebKit.git",
    sentinels: [
      "Source/JavaScriptCore/CMakeLists.txt",
      "Source/WebCore/LICENSE-LGPL-2",
      "Source/WebCore/LICENSE-LGPL-2.1",
    ],
    externalSources: [],
    submodules: [],
  },
  {
    archiveName: "git-67ad42147a7acc2af6074753ebd03d904476118f-source.tar.gz",
    archivePrefix: "git-67ad42147a7acc2af6074753ebd03d904476118f/",
    commit: "67ad42147a7acc2af6074753ebd03d904476118f",
    minimumEntries: 4_000,
    project: "Git",
    repository: "https://github.com/git/git.git",
    sentinels: ["COPYING", "Makefile", "git.c"],
    externalSources: [],
    submodules: [],
  },
  {
    archiveName: "dugite-native-f49d0098409aa243de8b9162127025ab0bb07a88-source.tar.gz",
    archivePrefix: "dugite-native-f49d0098409aa243de8b9162127025ab0bb07a88/",
    commit: "f49d0098409aa243de8b9162127025ab0bb07a88",
    minimumEntries: 30,
    project: "Dugite Native",
    repository: "https://github.com/desktop/dugite-native.git",
    sentinels: [".gitmodules", "LICENSE.md", "script/build-macos.sh"],
    externalSources: [],
    gitmodulesSha256: "4ad3b0539045e367e7385a4b7ed2827f6900138a0ad2ba5a32174d0de0c0e89c",
    submodules: [
      {
        archiveName: "git-67ad42147a7acc2af6074753ebd03d904476118f-source.tar.gz",
        commit: "67ad42147a7acc2af6074753ebd03d904476118f",
        path: "git",
        repository: "https://github.com/git/git.git",
      },
    ],
  },
] as const satisfies readonly CorrespondingSourceSpec[]);

async function run(
  argv: readonly string[],
  options: Readonly<{ cwd?: string; env?: Readonly<Record<string, string | undefined>> }> = {},
): Promise<string> {
  const child = Bun.spawn([...argv], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env ?? process.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${argv.join(" ")} failed with exit code ${exitCode}: ${stderr.trim()}`);
  }
  return stdout;
}

async function sha256File(path: string): Promise<string> {
  const handle = await open(path, "r");
  const hasher = createHash("sha256");
  try {
    for await (const chunk of handle.readableWebStream()) {
      hasher.update(chunk as Uint8Array);
    }
  } finally {
    await handle.close();
  }
  return hasher.digest("hex");
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sourceManifest(spec: CorrespondingSourceSpec): Readonly<{
  commit: string;
  externalSources: readonly CorrespondingSourceExternal[];
  project: string;
  repository: string;
  schemaVersion: 1;
  submodules: readonly CorrespondingSourceSubmodule[];
}> {
  return {
    commit: spec.commit,
    externalSources: spec.externalSources,
    project: spec.project,
    repository: spec.repository,
    schemaVersion: 1,
    submodules: spec.submodules,
  };
}

function safeArchivePath(path: string): boolean {
  return path.length > 0
    && !path.startsWith("/")
    && !path.split("/").includes("..")
    && !path.includes("\0")
    && !path.includes("\n")
    && !path.includes("\r");
}

function safeSymlinkTarget(target: string, resolved: string): boolean {
  return target.length > 0
    && !target.includes("\0")
    && !target.includes("\n")
    && !target.includes("\r")
    && !posix.isAbsolute(target)
    && resolved !== ".."
    && !resolved.startsWith("../")
    && safeArchivePath(resolved);
}

function verifyArchiveEntryTypes(
  entries: readonly string[],
  verboseLines: readonly string[],
  project: string,
  archivePrefix: string,
): void {
  if (entries.length !== verboseLines.length) {
    throw new Error(`${project} source archive listings disagree.`);
  }
  for (const [index, entry] of entries.entries()) {
    const line = verboseLines[index]!;
    const type = line[0];
    if (type !== "-" && type !== "d" && type !== "l") {
      throw new Error(`${project} source archive contains a special or hardlink entry.`);
    }
    if (type !== "l") continue;
    const marker = `${entry} -> `;
    const markerIndex = line.lastIndexOf(marker);
    if (markerIndex === -1) {
      throw new Error(`${project} source archive symlink listing is malformed.`);
    }
    const target = line.slice(markerIndex + marker.length);
    const relativeEntry = entry.slice(archivePrefix.length);
    const resolved = posix.normalize(posix.join(posix.dirname(relativeEntry), target));
    if (!safeSymlinkTarget(target, resolved)) {
      throw new Error(`${project} source archive symlink escapes its root.`);
    }
  }
}

async function verifyExternalSources(
  archivePath: string,
  entries: readonly string[],
  spec: CorrespondingSourceSpec,
): Promise<void> {
  const paths = new Set(entries);
  const embedded = spec.externalSources.filter(
    (source): source is CorrespondingSourceExternalArchive | CorrespondingSourceExternalGit =>
      source.kind !== "linked-archive",
  );
  const externalRoot = `${spec.archivePrefix}HRA-EXTERNAL-SOURCES/`;
  const embeddedPrefixes = embedded.map((source) =>
    `${spec.archivePrefix}${source.archivePath}/`);
  const unexpectedExternal = entries.find((entry) =>
    entry.startsWith(externalRoot)
    && entry !== externalRoot
    && !embeddedPrefixes.some((prefix) => entry.startsWith(prefix)));
  if (unexpectedExternal !== undefined) {
    throw new Error(`${spec.project} source archive has an undeclared external source: ${unexpectedExternal}`);
  }
  const evidencePaths = spec.externalSources.flatMap((source) => {
    const declarationPath = `${spec.archivePrefix}${source.declaration.path}`;
    if (!paths.has(declarationPath)) {
      throw new Error(`${spec.project} source archive lacks ${source.declaration.path}.`);
    }
    if (source.kind !== "git" || source.cargoVendor === undefined) {
      return [declarationPath];
    }
    const prefix = `${spec.archivePrefix}${source.archivePath}/`;
    const vendorPrefix = `${prefix}${source.cargoVendor.path}/`;
    return [
      declarationPath,
      `${prefix}${source.cargoVendor.lockPath}`,
      ...entries.filter((entry) =>
        entry.startsWith(vendorPrefix) && entry.endsWith("/.cargo-checksum.json")),
    ];
  });
  const extractionRoot = await mkdtemp(join(tmpdir(), "hra-source-evidence-"));
  try {
    await run([
      "/usr/bin/tar",
      "-xzf",
      archivePath,
      "-C",
      extractionRoot,
      ...evidencePaths,
    ]);
    const evidenceText = async (path: string): Promise<string> => {
      const absolutePath = join(extractionRoot, path);
      const status = await lstat(absolutePath);
      if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1 || status.size <= 0) {
        throw new Error(`${spec.project} source evidence is not a regular file: ${path}`);
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(await readFile(absolutePath));
    };
    for (const source of spec.externalSources) {
      const declarationPath = `${spec.archivePrefix}${source.declaration.path}`;
      if (sha256Text(await evidenceText(declarationPath)) !== source.declaration.sha256) {
        throw new Error(`${spec.project} external-source declaration differs: ${source.project}.`);
      }
      if (source.kind === "linked-archive") {
        const linked = correspondingSourceSpecs.find((candidate) =>
          candidate.archiveName === source.archiveName);
        if (
          linked === undefined
          || linked.commit !== source.commit
          || linked.repository !== source.repository
        ) {
          throw new Error(`${spec.project} linked source archive differs: ${source.project}.`);
        }
        continue;
      }
      const prefix = `${spec.archivePrefix}${source.archivePath}/`;
      const sourceEntries = entries.filter((entry) => entry.startsWith(prefix));
      if (sourceEntries.length < source.minimumEntries) {
        throw new Error(`${spec.project} external source is unexpectedly small: ${source.project}.`);
      }
      for (const sentinel of source.sentinels) {
        if (!paths.has(`${prefix}${sentinel}`)) {
          throw new Error(`${spec.project} external source lacks ${source.project}/${sentinel}.`);
        }
      }
      if (source.kind === "git") {
        for (const submodule of source.submodules) {
          if (submodule.archiveName !== undefined) continue;
          const submodulePrefix = `${prefix}${submodule.path}/`;
          const submoduleEntries = entries.filter((entry) => entry.startsWith(submodulePrefix));
          if (submoduleEntries.length < (submodule.minimumEntries ?? Number.POSITIVE_INFINITY)) {
            throw new Error(
              `${source.project} embedded submodule is unexpectedly small: ${submodule.path}.`,
            );
          }
          for (const sentinel of submodule.sentinels ?? []) {
            if (!paths.has(`${submodulePrefix}${sentinel}`)) {
              throw new Error(
                `${source.project} embedded submodule lacks ${submodule.path}/${sentinel}.`,
              );
            }
          }
        }
      }
      if (source.kind === "git" && source.cargoVendor !== undefined) {
        const vendor = source.cargoVendor;
        const lockPath = `${prefix}${vendor.lockPath}`;
        if (sha256Text(await evidenceText(lockPath)) !== vendor.lockSha256) {
          throw new Error(`${source.project} Cargo.lock differs from its pin.`);
        }
        if (!paths.has(`${prefix}${vendor.configPath}`)) {
          throw new Error(`${source.project} source archive lacks its Cargo vendor config.`);
        }
        const vendorPrefix = `${prefix}${vendor.path}/`;
        const checksumPaths = entries.filter((entry) =>
          entry.startsWith(vendorPrefix) && entry.endsWith("/.cargo-checksum.json"));
        if (checksumPaths.length !== vendor.packageCount) {
          throw new Error(`${source.project} Cargo vendor package count differs.`);
        }
        const manifestLines: string[] = [];
        for (const checksumPath of checksumPaths.sort()) {
          const relativePath = checksumPath.slice(vendorPrefix.length);
          const digest = sha256Text(await evidenceText(checksumPath));
          manifestLines.push(`./${relativePath} ${digest}\n`);
        }
        if (sha256Text(manifestLines.join("")) !== vendor.checksumManifestSha256) {
          throw new Error(`${source.project} Cargo vendor checksum manifest differs.`);
        }
      }
    }
  } finally {
    await rm(extractionRoot, { force: true, recursive: true });
  }
}

export async function verifyCorrespondingSourceArchive(
  archivePath: string,
  spec: CorrespondingSourceSpec,
): Promise<CorrespondingSourceEvidence> {
  const status = await lstat(archivePath);
  if (
    !status.isFile()
    || status.isSymbolicLink()
    || status.nlink !== 1
    || status.size <= 0
  ) {
    throw new Error(`Corresponding source archive is not a regular file: ${archivePath}`);
  }
  if (status.size >= githubReleaseAssetByteLimit) {
    throw new Error(`Corresponding source archive exceeds GitHub's 2 GiB asset limit: ${archivePath}`);
  }
  const listing = await run(["/usr/bin/tar", "-tzf", archivePath]);
  const entries = listing.split("\n").filter((entry) => entry.length > 0);
  const verboseListing = await run(["/usr/bin/tar", "-tvzf", archivePath]);
  const verboseLines = verboseListing.split("\n").filter((entry) => entry.length > 0);
  if (entries.length < spec.minimumEntries) {
    throw new Error(`${spec.project} source archive is unexpectedly small.`);
  }
  if (entries.some((entry) =>
    !entry.startsWith(spec.archivePrefix)
    || !safeArchivePath(entry))) {
    throw new Error(`${spec.project} source archive contains an unsafe path.`);
  }
  if (new Set(entries).size !== entries.length) {
    throw new Error(`${spec.project} source archive contains duplicate paths.`);
  }
  verifyArchiveEntryTypes(entries, verboseLines, spec.project, spec.archivePrefix);
  const paths = new Set(entries);
  for (const sentinel of spec.sentinels) {
    if (!paths.has(`${spec.archivePrefix}${sentinel}`)) {
      throw new Error(`${spec.project} source archive lacks ${sentinel}.`);
    }
  }
  const manifestPath = `${spec.archivePrefix}${sourceManifestName}`;
  if (!paths.has(manifestPath)) {
    throw new Error(`${spec.project} source archive lacks its source manifest.`);
  }
  const manifestText = await run([
    "/usr/bin/tar",
    "-xOzf",
    archivePath,
    manifestPath,
  ]);
  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(manifestText) as unknown;
  } catch (error) {
    throw new Error(`${spec.project} source manifest is invalid JSON.`, { cause: error });
  }
  if (JSON.stringify(parsedManifest) !== JSON.stringify(sourceManifest(spec))) {
    throw new Error(`${spec.project} source manifest differs from its pin.`);
  }
  await verifyExternalSources(archivePath, entries, spec);
  return {
    archiveName: spec.archiveName,
    bytes: status.size,
    commit: spec.commit,
    project: spec.project,
    repository: spec.repository,
    sha256: await sha256File(archivePath),
    externalSources: spec.externalSources,
    submodules: spec.submodules,
  };
}

async function verifySubmodulePins(
  repositoryRoot: string,
  spec: CorrespondingSourceSpec | CorrespondingSourceExternalGit,
): Promise<void> {
  const tree = await run([
    "/usr/bin/git",
    "-C",
    repositoryRoot,
    "ls-tree",
    "-r",
    spec.commit,
  ]);
  const treeLines = tree.split("\n").filter((line) => line.length > 0);
  const actualGitlinks = treeLines
    .filter((line) => line.startsWith("160000 commit "))
    .sort();
  const expectedGitlinks = spec.submodules.map(
    (submodule) => `160000 commit ${submodule.commit}\t${submodule.path}`,
  ).sort();
  if (JSON.stringify(actualGitlinks) !== JSON.stringify(expectedGitlinks)) {
    throw new Error(`${spec.project} gitlink set differs from its pins.`);
  }
  const hasGitmodules = treeLines.some((line) => line.endsWith("\t.gitmodules"));
  if (hasGitmodules !== (spec.gitmodulesSha256 !== undefined)) {
    throw new Error(`${spec.project} .gitmodules presence differs from its pin.`);
  }
  if (spec.submodules.length === 0) {
    if (spec.gitmodulesSha256 !== undefined) {
      throw new Error(`${spec.project} has a .gitmodules pin without submodules.`);
    }
  } else {
    const gitmodules = await run([
      "/usr/bin/git",
      "-C",
      repositoryRoot,
      "show",
      `${spec.commit}:.gitmodules`,
    ]);
    if (sha256Text(gitmodules) !== spec.gitmodulesSha256) {
      throw new Error(`${spec.project} .gitmodules differs from its pin.`);
    }
  }
  for (const submodule of spec.submodules) {
    if (!safeArchivePath(submodule.path)) {
      throw new Error(`${spec.project} has an unsafe submodule path.`);
    }
    const treeEntry = await run([
      "/usr/bin/git",
      "-C",
      repositoryRoot,
      "ls-tree",
      spec.commit,
      "--",
      submodule.path,
    ]);
    const expected = `160000 commit ${submodule.commit}\t${submodule.path}\n`;
    if (treeEntry !== expected) {
      throw new Error(`${spec.project} submodule ${submodule.path} differs from its pin.`);
    }
    if (submodule.archiveName !== undefined) {
      const sourceSpec = correspondingSourceSpecs.find(
        (candidate) => candidate.archiveName === submodule.archiveName,
      );
      if (
        sourceSpec === undefined
        || sourceSpec.commit !== submodule.commit
        || sourceSpec.repository !== submodule.repository
      ) {
        throw new Error(`${spec.project} submodule ${submodule.path} lacks a matching source archive.`);
      }
    } else if (
      !("archivePath" in spec)
      || submodule.minimumEntries === undefined
      || submodule.sentinels === undefined
    ) {
      throw new Error(`${spec.project} submodule ${submodule.path} lacks embedded-source evidence.`);
    }
  }
}

async function fetchGitSource(
  workRoot: string,
  key: string,
  spec: CorrespondingSourceSpec | CorrespondingSourceExternalGit,
): Promise<string> {
  const repositoryRoot = join(workRoot, key);
  await run(["/usr/bin/git", "init", "--bare", repositoryRoot]);
  await run(["/usr/bin/git", "-C", repositoryRoot, "remote", "add", "origin", spec.repository]);
  await run([
    "/usr/bin/git",
    "-C",
    repositoryRoot,
    "-c",
    "protocol.version=2",
    "fetch",
    "--depth=1",
    "--no-tags",
    "origin",
    spec.commit,
  ]);
  const resolved = (await run([
    "/usr/bin/git",
    "-C",
    repositoryRoot,
    "rev-parse",
    "FETCH_HEAD^{commit}",
  ])).trim();
  if (resolved !== spec.commit) {
    throw new Error(`${spec.project} resolved ${resolved}, expected ${spec.commit}.`);
  }
  await verifySubmodulePins(repositoryRoot, spec);
  return repositoryRoot;
}

async function extractGitSource(
  repositoryRoot: string,
  commit: string,
  destination: string,
  workRoot: string,
): Promise<void> {
  await mkdir(destination, { recursive: true });
  const archivePath = join(workRoot, `extract-${createHash("sha256").update(destination).digest("hex")}.tar`);
  await run([
    "/usr/bin/git",
    "-C",
    repositoryRoot,
    "archive",
    "--format=tar",
    `--output=${archivePath}`,
    commit,
  ]);
  await run(["/usr/bin/tar", "-xf", archivePath, "-C", destination]);
  await rm(archivePath, { force: true });
}

async function fetchEmbeddedSubmoduleSource(
  workRoot: string,
  key: string,
  project: string,
  submodule: CorrespondingSourceSubmodule,
): Promise<string> {
  const repositoryRoot = join(workRoot, key);
  await run(["/usr/bin/git", "init", "--bare", repositoryRoot]);
  await run(["/usr/bin/git", "-C", repositoryRoot, "remote", "add", "origin", submodule.repository]);
  await run([
    "/usr/bin/git",
    "-C",
    repositoryRoot,
    "-c",
    "protocol.version=2",
    "fetch",
    "--depth=1",
    "--no-tags",
    "origin",
    submodule.commit,
  ]);
  const resolved = (await run([
    "/usr/bin/git",
    "-C",
    repositoryRoot,
    "rev-parse",
    "FETCH_HEAD^{commit}",
  ])).trim();
  if (resolved !== submodule.commit) {
    throw new Error(
      `${project} submodule ${submodule.path} resolved ${resolved}, expected ${submodule.commit}.`,
    );
  }
  const tree = (await run([
    "/usr/bin/git",
    "-C",
    repositoryRoot,
    "ls-tree",
    "-r",
    submodule.commit,
  ])).split("\n").filter((line) => line.length > 0);
  if (
    tree.some((line) => line.startsWith("160000 commit "))
    || tree.some((line) => line.endsWith("\t.gitmodules"))
  ) {
    throw new Error(`${project} submodule ${submodule.path} has an undeclared nested gitlink.`);
  }
  return repositoryRoot;
}

async function verifyDownloadedSourceArchive(
  archivePath: string,
  source: CorrespondingSourceExternalArchive,
): Promise<void> {
  const status = await lstat(archivePath);
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
    throw new Error(`${source.project} download is not a regular file.`);
  }
  if (await sha256File(archivePath) !== source.sha256) {
    throw new Error(`${source.project} download hash differs from its pin.`);
  }
  const entries = (await run(["/usr/bin/tar", "-tzf", archivePath]))
    .split("\n").filter((entry) => entry.length > 0);
  const verboseLines = (await run(["/usr/bin/tar", "-tvzf", archivePath]))
    .split("\n").filter((entry) => entry.length > 0);
  if (
    entries.length < source.minimumEntries
    || entries.some((entry) =>
      !entry.startsWith(source.sourceArchivePrefix) || !safeArchivePath(entry))
    || new Set(entries).size !== entries.length
  ) {
    throw new Error(`${source.project} download tree differs from its pin.`);
  }
  verifyArchiveEntryTypes(entries, verboseLines, source.project, source.sourceArchivePrefix);
}

async function downloadExternalArchive(
  source: CorrespondingSourceExternalArchive,
  destination: string,
  workRoot: string,
): Promise<void> {
  const response = await fetch(source.url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`${source.project} download failed with HTTP ${response.status}.`);
  }
  const downloadPath = join(workRoot, `${source.project.replaceAll(/[^A-Za-z0-9.-]/gu, "-")}.tar.gz`);
  await writeFile(downloadPath, new Uint8Array(await response.arrayBuffer()), { flag: "wx" });
  await verifyDownloadedSourceArchive(downloadPath, source);
  const extractRoot = join(workRoot, `${source.project.replaceAll(/[^A-Za-z0-9.-]/gu, "-")}-extract`);
  await mkdir(extractRoot, { recursive: true });
  await run(["/usr/bin/tar", "-xzf", downloadPath, "-C", extractRoot]);
  const sourceRoot = join(extractRoot, source.sourceArchivePrefix.slice(0, -1));
  await mkdir(join(destination, ".."), { recursive: true });
  await rename(sourceRoot, destination);
  await rm(extractRoot, { force: true, recursive: true });
  await rm(downloadPath, { force: true });
}

async function cargoVendor(
  sourceRoot: string,
  spec: NonNullable<CorrespondingSourceExternalGit["cargoVendor"]>,
): Promise<void> {
  const lockPath = join(sourceRoot, spec.lockPath);
  if (sha256Text(await readFile(lockPath, "utf8")) !== spec.lockSha256) {
    throw new Error("lol-html Cargo.lock differs from its pin.");
  }
  const cargo = Bun.which("cargo");
  if (cargo === null) {
    throw new Error("cargo is required to materialize lol-html's locked source closure.");
  }
  const vendorRoot = join(sourceRoot, spec.path);
  await run([
    cargo,
    "vendor",
    "--locked",
    "--versioned-dirs",
    vendorRoot,
    "--manifest-path",
    join(sourceRoot, "c-api/Cargo.toml"),
  ], { cwd: sourceRoot });
  const packages = (await readdir(vendorRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (packages.length !== spec.packageCount) {
    throw new Error(`lol-html Cargo vendor package count differs: ${packages.length}.`);
  }
  const manifestLines: string[] = [];
  for (const packageName of packages) {
    const checksumPath = join(vendorRoot, packageName, ".cargo-checksum.json");
    manifestLines.push(
      `./${packageName}/.cargo-checksum.json ${await sha256File(checksumPath)}\n`,
    );
  }
  if (sha256Text(manifestLines.join("")) !== spec.checksumManifestSha256) {
    throw new Error("lol-html Cargo vendor checksums differ from their pin.");
  }
  await writeFile(
    join(sourceRoot, spec.configPath),
    `[source.crates-io]\nreplace-with = "vendored-sources"\n\n[source.vendored-sources]\ndirectory = "${spec.path}"\n`,
    { flag: "wx" },
  );
}

async function normalizeTreeTimestamps(root: string, timestamp: number): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      if (entry.isSymbolicLink()) await lutimes(path, timestamp, timestamp);
      else await utimes(path, timestamp, timestamp);
    }
  };
  await visit(root);
  await utimes(root, timestamp, timestamp);
}

async function deterministicTarPaths(root: string, rootName: string): Promise<string[]> {
  const paths = [`${rootName}/`];
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (!safeArchivePath(relativePath)) {
        throw new Error(`Source staging tree contains an unsafe path: ${relativePath}`);
      }
      paths.push(entry.isDirectory() ? `${relativePath}/` : relativePath);
      if (entry.isDirectory()) await visit(join(directory, entry.name), relativePath);
    }
  };
  await visit(root, rootName);
  return paths;
}

async function createCompleteBunArchive(
  outputDirectory: string,
  spec: CorrespondingSourceSpec,
  workRoot: string,
): Promise<CorrespondingSourceEvidence> {
  const repositoryRoot = await fetchGitSource(workRoot, "bun", spec);
  const stageParent = join(workRoot, "complete-stage");
  const rootName = spec.archivePrefix.slice(0, -1);
  const stageRoot = join(stageParent, rootName);
  await mkdir(stageParent, { recursive: true });
  await extractGitSource(repositoryRoot, spec.commit, stageRoot, workRoot);
  const commitTimestamp = Number((await run([
    "/usr/bin/git",
    "-C",
    repositoryRoot,
    "show",
    "-s",
    "--format=%ct",
    spec.commit,
  ])).trim());
  await rm(repositoryRoot, { force: true, recursive: true });
  for (const [index, source] of spec.externalSources.entries()) {
    if (source.kind === "linked-archive") continue;
    process.stderr.write(`[corresponding-source] fetching ${source.project}\n`);
    const destination = join(stageRoot, source.archivePath);
    if (source.kind === "archive") {
      await downloadExternalArchive(source, destination, workRoot);
      continue;
    }
    const externalRepository = await fetchGitSource(workRoot, `external-${index}`, source);
    await extractGitSource(externalRepository, source.commit, destination, workRoot);
    for (const [submoduleIndex, submodule] of source.submodules.entries()) {
      if (submodule.archiveName !== undefined) continue;
      process.stderr.write(
        `[corresponding-source] fetching ${source.project} submodule ${submodule.path}\n`,
      );
      const submoduleRepository = await fetchEmbeddedSubmoduleSource(
        workRoot,
        `external-${index}-submodule-${submoduleIndex}`,
        source.project,
        submodule,
      );
      await extractGitSource(
        submoduleRepository,
        submodule.commit,
        join(destination, submodule.path),
        workRoot,
      );
      await rm(submoduleRepository, { force: true, recursive: true });
    }
    await rm(externalRepository, { force: true, recursive: true });
    if (source.cargoVendor !== undefined) {
      await cargoVendor(destination, source.cargoVendor);
    }
  }
  const manifestText = JSON.stringify(sourceManifest(spec));
  await writeFile(join(stageRoot, sourceManifestName), manifestText, { flag: "wx" });
  if (!Number.isSafeInteger(commitTimestamp) || commitTimestamp <= 0) {
    throw new Error("Bun source timestamp is invalid.");
  }
  await normalizeTreeTimestamps(stageRoot, commitTimestamp);
  const paths = await deterministicTarPaths(stageRoot, rootName);
  const pathsFile = join(workRoot, "bun-complete-paths.txt");
  await writeFile(pathsFile, `${paths.join("\n")}\n`, { flag: "wx" });
  const tarPath = join(workRoot, "bun-complete-source.tar");
  await run([
    "/usr/bin/tar",
    "--no-xattrs",
    "--no-mac-metadata",
    "--uid",
    "0",
    "--gid",
    "0",
    "--numeric-owner",
    "--no-recursion",
    "-cf",
    tarPath,
    "-C",
    stageParent,
    "-T",
    pathsFile,
  ], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  await run(["/usr/bin/gzip", "-n", "-9", tarPath]);
  const archivePath = join(outputDirectory, spec.archiveName);
  await rename(`${tarPath}.gz`, archivePath);
  const evidence = await verifyCorrespondingSourceArchive(archivePath, spec);
  await rm(stageParent, { force: true, recursive: true });
  return evidence;
}

export async function createCorrespondingSourceArchives(
  outputDirectory: string,
  specs: readonly CorrespondingSourceSpec[] = correspondingSourceSpecs,
): Promise<readonly CorrespondingSourceEvidence[]> {
  await mkdir(outputDirectory, { recursive: true });
  const workRoot = await mkdtemp(join(tmpdir(), "hra-corresponding-source-"));
  const evidence: CorrespondingSourceEvidence[] = [];
  try {
    for (const spec of specs) {
      process.stderr.write(`[corresponding-source] fetching ${spec.project} ${spec.commit}\n`);
      if (spec.project === "Bun") {
        evidence.push(await createCompleteBunArchive(outputDirectory, spec, workRoot));
        process.stderr.write(`[corresponding-source] verified ${spec.archiveName}\n`);
        continue;
      }
      const repositoryRoot = await fetchGitSource(
        workRoot,
        spec.project.toLowerCase().replaceAll(" ", "-"),
        spec,
      );
      const manifestPath = join(workRoot, sourceManifestName);
      const manifestText = JSON.stringify(sourceManifest(spec));
      await writeFile(manifestPath, manifestText);
      const commitTimestamp = Number((await run([
        "/usr/bin/git",
        "-C",
        repositoryRoot,
        "show",
        "-s",
        "--format=%ct",
        spec.commit,
      ])).trim());
      if (!Number.isSafeInteger(commitTimestamp) || commitTimestamp <= 0) {
        throw new Error(`${spec.project} commit timestamp is invalid.`);
      }
      await utimes(manifestPath, commitTimestamp, commitTimestamp);
      const archivePath = join(outputDirectory, spec.archiveName);
      await run([
        "/usr/bin/git",
        "-C",
        repositoryRoot,
        "archive",
        "--format=tar.gz",
        `--prefix=${spec.archivePrefix}`,
        `--add-file=${manifestPath}`,
        `--output=${archivePath}`,
        spec.commit,
      ]);
      evidence.push(await verifyCorrespondingSourceArchive(archivePath, spec));
      process.stderr.write(`[corresponding-source] verified ${spec.archiveName}\n`);
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  } finally {
    await rm(workRoot, { force: true, recursive: true });
  }
  return evidence;
}
