import { dlopen } from "bun:ffi";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import { z } from "zod";

import {
  PROTECTED_INTERACTION_DETAIL_MAXIMUM_BYTES,
  encodeProtectedInteractionDetailDocument,
  protectedInteractionDetailDocumentSchema,
  type ProtectedInteractionDetailDocument,
} from "../domain/interactions";
import { profileIdSchema } from "../domain/values";

export const DEVICE_LOGIN_DOCUMENT_MAXIMUM_BYTES = 64 * 1024;

type FileIdentity = Readonly<{
  device: number;
  inode: number;
  links: number;
  mode: number;
  owner: number;
}>;

type DirectoryIdentity = Omit<FileIdentity, "links">;

export type ProtectedOutputTestHooks = Readonly<{
  beforeChildOpen?: () => void;
  beforePostflight?: () => void;
  beforeWrite?: () => void;
  expectedOwnerUid?: number;
  inspectDescriptorExtendedAcl?: (descriptor: number) => ProtectedOutputAclInspection;
  loadNativeOpenAtLibrary?: () => ProtectedOutputNativeOpenAtLibrary | null;
  platform?: NodeJS.Platform;
}>;

export class ProtectedOutputError extends Error {
  constructor(
    readonly code:
      | "unsupported"
      | "path_invalid"
      | "parent_invalid"
      | "file_invalid"
      | "file_not_empty"
      | "binding_changed"
      | "document_invalid"
      | "write_unproven",
  ) {
    super(code);
    this.name = "ProtectedOutputError";
  }
}

export type ProtectedOutputNativeOpenAtLibrary = Readonly<{
  symbols: Readonly<{
    openat: (
      parentDescriptor: number,
      path: Uint8Array,
      flags: number,
      mode: number,
    ) => number;
  }>;
}>;

export type ProtectedOutputNativeAclLibrary = Readonly<{
  symbols: Readonly<{
    fgetattrlist: (
      descriptor: number,
      attributes: Uint8Array,
      result: Uint8Array,
      resultSize: number,
      options: number,
    ) => number;
  }>;
}>;

export type ProtectedOutputAclInspection = "clear" | "present" | "indeterminate";

export type ProtectedOutputAclPolicy =
  | "darwin_descriptor_extended_acl"
  | "linux_mode_acl_mask";

export const protectedOutputAclPolicyForPlatform = (
  platform: NodeJS.Platform,
): ProtectedOutputAclPolicy | null => platform === "darwin"
  ? "darwin_descriptor_extended_acl"
  : platform === "linux"
    ? "linux_mode_acl_mask"
    : null;

export const protectedOutputAclLibrariesForPlatform = (
  platform: NodeJS.Platform,
): readonly string[] => platform === "darwin"
  ? ["/usr/lib/libSystem.B.dylib"]
  : [];

export const protectedOutputOpenAtLibrariesForPlatform = (
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): readonly string[] => {
  if (platform === "darwin") return ["/usr/lib/libSystem.B.dylib"];
  if (platform !== "linux") return [];
  const muslArchitecture = architecture === "x64"
    ? "x86_64"
    : architecture === "arm64"
      ? "aarch64"
      : null;
  if (muslArchitecture === null) return ["libc.so.6"];
  const muslLibrary = `libc.musl-${muslArchitecture}.so.1`;
  return [
    "libc.so.6",
    muslLibrary,
    `/lib/${muslLibrary}`,
    `/usr/lib/${muslLibrary}`,
  ];
};

type ProtectedOutputNativeLibraryOpener = (
  library: string,
) => ProtectedOutputNativeOpenAtLibrary;

const openNativeOpenAtLibrary: ProtectedOutputNativeLibraryOpener = (library) =>
  dlopen(library, {
    openat: { args: ["i32", "cstring", "i32", "u32"], returns: "i32" },
  });

type ProtectedOutputNativeAclLibraryOpener = (
  library: string,
) => ProtectedOutputNativeAclLibrary;

const openNativeAclLibrary: ProtectedOutputNativeAclLibraryOpener = (library) =>
  dlopen(library, {
    fgetattrlist: {
      args: ["i32", "ptr", "ptr", "usize", "usize"],
      returns: "i32",
    },
  });

export const loadProtectedOutputNativeOpenAtLibrary = (
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
  openLibrary: ProtectedOutputNativeLibraryOpener = openNativeOpenAtLibrary,
): ProtectedOutputNativeOpenAtLibrary | null => {
  for (const library of protectedOutputOpenAtLibrariesForPlatform(platform, architecture)) {
    try {
      return openLibrary(library);
    } catch {
      // Try the next platform libc name. Protected output fails closed if none load.
    }
  }
  return null;
};

export const loadProtectedOutputNativeAclLibrary = (
  platform: NodeJS.Platform,
  openLibrary: ProtectedOutputNativeAclLibraryOpener = openNativeAclLibrary,
): ProtectedOutputNativeAclLibrary | null => {
  for (const library of protectedOutputAclLibrariesForPlatform(platform)) {
    try {
      return openLibrary(library);
    } catch {
      // Darwin protected output fails closed if the descriptor ACL API cannot load.
    }
  }
  return null;
};

let processNativeOpenAtLibrary: ProtectedOutputNativeOpenAtLibrary | null | undefined;
let processNativeAclLibrary: ProtectedOutputNativeAclLibrary | null | undefined;

const loadProcessNativeOpenAtLibrary = (): ProtectedOutputNativeOpenAtLibrary | null => {
  if (processNativeOpenAtLibrary !== undefined) return processNativeOpenAtLibrary;
  processNativeOpenAtLibrary = loadProtectedOutputNativeOpenAtLibrary(
    process.platform,
    process.arch,
  );
  return processNativeOpenAtLibrary;
};

const loadProcessNativeAclLibrary = (): ProtectedOutputNativeAclLibrary | null => {
  if (processNativeAclLibrary !== undefined) return processNativeAclLibrary;
  processNativeAclLibrary = loadProtectedOutputNativeAclLibrary(process.platform);
  return processNativeAclLibrary;
};

const DARWIN_ATTR_BIT_MAP_COUNT = 5;
const DARWIN_ATTR_CMN_EXTENDED_SECURITY = 0x00400000;
const DARWIN_ATTR_CMN_RETURNED_ATTRS = 0x80000000;
const DARWIN_ATTR_CMN_ACL_REQUEST = (
  DARWIN_ATTR_CMN_RETURNED_ATTRS | DARWIN_ATTR_CMN_EXTENDED_SECURITY
) >>> 0;
const DARWIN_FSOPT_REPORT_FULLSIZE = 0x00000004;
const DARWIN_ATTR_LIST_BYTES = 24;
const DARWIN_ATTR_RESULT_BYTES = 32;

export const parseProtectedOutputDarwinAclResult = (
  returnCode: number,
  result: Uint8Array,
): ProtectedOutputAclInspection => {
  if (
    returnCode !== 0
    || result.byteLength !== DARWIN_ATTR_RESULT_BYTES
    || result.byteOffset % Uint32Array.BYTES_PER_ELEMENT !== 0
  ) return "indeterminate";
  const words = new Uint32Array(
    result.buffer,
    result.byteOffset,
    DARWIN_ATTR_RESULT_BYTES / Uint32Array.BYTES_PER_ELEMENT,
  );
  const reportedSize = words[0];
  const common = words[1];
  if (
    words[2] !== 0
    || words[3] !== 0
    || words[4] !== 0
    || words[5] !== 0
  ) return "indeterminate";
  if (common === DARWIN_ATTR_CMN_ACL_REQUEST) return "present";
  if (
    common !== DARWIN_ATTR_CMN_RETURNED_ATTRS
    || reportedSize !== DARWIN_ATTR_RESULT_BYTES
    || words[6] !== 0
    || words[7] !== 0
  ) return "indeterminate";
  return "clear";
};

export const inspectProtectedOutputDarwinDescriptorAcl = (
  descriptor: number,
  loadNativeAclLibrary: () => ProtectedOutputNativeAclLibrary | null = loadProcessNativeAclLibrary,
): ProtectedOutputAclInspection => {
  let library: ProtectedOutputNativeAclLibrary | null;
  try {
    library = loadNativeAclLibrary();
  } catch {
    return "indeterminate";
  }
  if (library === null) return "indeterminate";
  const attributes = new Uint8Array(DARWIN_ATTR_LIST_BYTES);
  const result = new Uint8Array(DARWIN_ATTR_RESULT_BYTES);
  const attributeHeader = new Uint16Array(attributes.buffer, attributes.byteOffset, 2);
  const attributeGroups = new Uint32Array(attributes.buffer, attributes.byteOffset + 4, 5);
  attributeHeader[0] = DARWIN_ATTR_BIT_MAP_COUNT;
  attributeGroups[0] = DARWIN_ATTR_CMN_ACL_REQUEST;
  let returnCode: number | undefined;
  try {
    returnCode = library.symbols.fgetattrlist(
      descriptor,
      attributes,
      result,
      result.byteLength,
      DARWIN_FSOPT_REPORT_FULLSIZE,
    );
    return parseProtectedOutputDarwinAclResult(returnCode, result);
  } catch {
    return "indeterminate";
  } finally {
    attributes.fill(0);
    result.fill(0);
  }
};

const proveDescriptorAcl = (
  descriptor: number,
  policy: ProtectedOutputAclPolicy,
  inspectDescriptorExtendedAcl: (descriptor: number) => ProtectedOutputAclInspection,
  aclPresentCode: "parent_invalid" | "file_invalid" | "binding_changed" | "write_unproven",
): void => {
  if (policy === "linux_mode_acl_mask") return;
  let inspection: ProtectedOutputAclInspection;
  try {
    inspection = inspectDescriptorExtendedAcl(descriptor);
  } catch {
    throw new ProtectedOutputError("unsupported");
  }
  if (inspection === "present") throw new ProtectedOutputError(aclPresentCode);
  if (inspection !== "clear") throw new ProtectedOutputError("unsupported");
};

const identity = (stats: Stats): FileIdentity => ({
  device: stats.dev,
  inode: stats.ino,
  links: stats.nlink,
  mode: stats.mode & 0o777,
  owner: stats.uid,
});

const directoryIdentity = (stats: Stats): DirectoryIdentity => {
  const value = identity(stats);
  return {
    device: value.device,
    inode: value.inode,
    mode: value.mode,
    owner: value.owner,
  };
};

const sameFile = (left: FileIdentity, right: FileIdentity): boolean =>
  left.device === right.device
  && left.inode === right.inode
  && left.links === right.links
  && left.mode === right.mode
  && left.owner === right.owner;

const sameDirectory = (left: DirectoryIdentity, right: DirectoryIdentity): boolean =>
  left.device === right.device
  && left.inode === right.inode
  && left.mode === right.mode
  && left.owner === right.owner;

const ownerUid = (): number => {
  const owner = process.getuid?.();
  if (owner === undefined) throw new ProtectedOutputError("unsupported");
  return owner;
};

const openChildAt = (
  parentDescriptor: number,
  name: string,
  flags: number,
  loadNativeOpenAtLibrary: () => ProtectedOutputNativeOpenAtLibrary | null,
): number => {
  if (
    basename(name) !== name
    || name === "."
    || name === ".."
  ) throw new ProtectedOutputError("unsupported");
  const nativeOpenAtLibrary = loadNativeOpenAtLibrary();
  if (nativeOpenAtLibrary === null) throw new ProtectedOutputError("unsupported");
  const encoded = Buffer.from(`${name}\0`, "utf8");
  try {
    const descriptor = nativeOpenAtLibrary.symbols.openat(
      parentDescriptor,
      encoded,
      flags | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0,
    );
    if (descriptor < 0) throw new ProtectedOutputError("file_invalid");
    return descriptor;
  } finally {
    encoded.fill(0);
  }
};

const proveDirectory = (
  path: string,
  descriptor: number,
  expectedOwnerUid: number,
): DirectoryIdentity => {
  const pathStats = lstatSync(path);
  const descriptorStats = fstatSync(descriptor);
  const pathIdentity = directoryIdentity(pathStats);
  const descriptorIdentity = directoryIdentity(descriptorStats);
  if (
    !pathStats.isDirectory()
    || pathStats.isSymbolicLink()
    || !descriptorStats.isDirectory()
    || pathIdentity.owner !== expectedOwnerUid
    || pathIdentity.mode !== 0o700
    || !sameDirectory(pathIdentity, descriptorIdentity)
    || realpathSync(path) !== path
  ) throw new ProtectedOutputError("parent_invalid");
  return descriptorIdentity;
};

const proveDocument = (descriptor: number, expectedOwnerUid: number): FileIdentity => {
  const stats = fstatSync(descriptor);
  const fileIdentity = identity(stats);
  if (
    !stats.isFile()
    || fileIdentity.owner !== expectedOwnerUid
    || fileIdentity.mode !== 0o600
    || fileIdentity.links !== 1
  ) throw new ProtectedOutputError("file_invalid");
  return fileIdentity;
};

const proveChildBinding = (
  parentDescriptor: number,
  name: string,
  expected: FileIdentity,
  expectedOwnerUid: number,
  loadNativeOpenAtLibrary: () => ProtectedOutputNativeOpenAtLibrary | null,
): void => {
  let reboundDescriptor: number | undefined;
  try {
    reboundDescriptor = openChildAt(
      parentDescriptor,
      name,
      constants.O_RDONLY,
      loadNativeOpenAtLibrary,
    );
    if (!sameFile(expected, proveDocument(reboundDescriptor, expectedOwnerUid))) {
      throw new ProtectedOutputError("binding_changed");
    }
  } finally {
    if (reboundDescriptor !== undefined) closeSync(reboundDescriptor);
  }
};

const accountProfileSchema = z.object({
  id: profileIdSchema,
  label: z.string().min(1).max(200),
  processGeneration: z.number().int().nonnegative(),
  providerEmail: z.string().email().max(320).optional(),
  providerPlan: z.string().min(1).max(200).optional(),
  state: z.enum(["signed_out", "login_pending", "signed_in", "recovery_required", "removed"]),
  updatedAt: z.number().int().nonnegative(),
}).strict();

export type AccountLoginAuthority = z.infer<typeof accountProfileSchema>;

const accountLoginAuthorityListSchema = z.object({
  accounts: z.array(accountProfileSchema).max(10_000),
}).strict().superRefine((value, context) => {
  if (new Set(value.accounts.map((account) => account.id)).size !== value.accounts.length) {
    context.addIssue({ code: "custom", message: "Account authorities must have distinct IDs." });
  }
});

export const parseAccountLoginAuthorityList = (value: unknown): readonly AccountLoginAuthority[] => {
  const parsed = accountLoginAuthorityListSchema.safeParse(value);
  if (!parsed.success) throw new ProtectedOutputError("document_invalid");
  return parsed.data.accounts;
};

const pendingLoginBase = {
  loginId: z.string().min(1).max(512).refine((value) => !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)),
  next: z.string().min(1).max(1_024),
  status: z.literal("pending"),
} as const;

const accountLoginResponseSchema = z.object({
  account: accountProfileSchema,
  idempotencyKey: z.string().uuid(),
  login: z.union([
    z.object({
      ...pendingLoginBase,
      userCode: z.string().min(1).max(128).optional(),
      verificationUrl: z.string().url().max(16_384),
    }).strict(),
    z.object(pendingLoginBase).strict(),
    z.object({
      account: z.object({
        email: z.string().email().max(320).optional(),
        plan: z.string().min(1).max(200).optional(),
        signedIn: z.literal(true),
      }).strict(),
      status: z.literal("signed_in"),
    }).strict(),
    z.object({
      outcome: z.literal("signed_out"),
      status: z.literal("settled"),
    }).strict(),
  ]),
}).strict();

export type DeviceLoginDocument = Readonly<{
  accountId: string;
  accountLabel: string;
  cancelCommand: string;
  method: "browser" | "device_code";
  type: "codex_device_login";
  userCode?: string;
  verificationUrl: string;
  version: 1;
}>;

export type ParsedAccountLoginResponse =
  | Readonly<{
      account: z.infer<typeof accountProfileSchema>;
      document: DeviceLoginDocument;
      idempotencyKey: string;
      kind: "handoff";
    }>
  | Readonly<{
      account: z.infer<typeof accountProfileSchema>;
      idempotencyKey: string;
      kind: "pending_replay";
    }>
  | Readonly<{
      account: z.infer<typeof accountProfileSchema>;
      idempotencyKey: string;
      kind: "signed_in";
    }>
  | Readonly<{
      account: z.infer<typeof accountProfileSchema>;
      idempotencyKey: string;
      kind: "settled";
    }>;

export const parseProtectedInteractionDetailResponse = (
  value: unknown,
  expected: Readonly<{ interactionId: string; revision: number }>,
): ProtectedInteractionDetailDocument => {
  const parsed = protectedInteractionDetailDocumentSchema.safeParse(value);
  if (!parsed.success) throw new ProtectedOutputError("document_invalid");
  const encoded = encodeProtectedInteractionDetailDocument(parsed.data);
  const valid = parsed.data.binding.interactionId === expected.interactionId
    && parsed.data.binding.revision === expected.revision
    && encoded.byteLength <= PROTECTED_INTERACTION_DETAIL_MAXIMUM_BYTES;
  encoded.fill(0);
  if (!valid) throw new ProtectedOutputError("document_invalid");
  return parsed.data;
};

export const parseAccountLoginResponse = (
  value: unknown,
  expected: Readonly<{
    accountId: string;
    deviceCode: boolean;
    idempotencyKey: string;
  }>,
): ParsedAccountLoginResponse => {
  const parsed = accountLoginResponseSchema.safeParse(value);
  if (
    !parsed.success
    || parsed.data.idempotencyKey !== expected.idempotencyKey
    || parsed.data.account.id !== expected.accountId
  ) {
    throw new ProtectedOutputError("document_invalid");
  }
  const { account, idempotencyKey, login } = parsed.data;
  if (login.status === "signed_in") {
    if (account.state !== "signed_in") throw new ProtectedOutputError("document_invalid");
    return { account, idempotencyKey, kind: "signed_in" };
  }
  if (login.status === "settled") {
    if (account.state !== "signed_out") throw new ProtectedOutputError("document_invalid");
    return { account, idempotencyKey, kind: "settled" };
  }
  if (
    account.state !== "login_pending"
    || login.next !== `hra account login-cancel ${expected.accountId}`
  ) throw new ProtectedOutputError("document_invalid");
  if (!("verificationUrl" in login)) {
    return { account, idempotencyKey, kind: "pending_replay" };
  }
  if (
    expected.deviceCode
      ? login.userCode === undefined
        || !/^[A-Z0-9]{4,12}(?:-[A-Z0-9]{4,12}){0,2}$/u.test(login.userCode)
      : login.userCode !== undefined
  ) {
    throw new ProtectedOutputError("document_invalid");
  }
  let url: URL;
  try {
    url = new URL(login.verificationUrl);
  } catch {
    throw new ProtectedOutputError("document_invalid");
  }
  const loopback = url.hostname === "localhost"
    || url.hostname === "127.0.0.1"
    || url.hostname === "[::1]";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    || url.username !== ""
    || url.password !== ""
  ) {
    throw new ProtectedOutputError("document_invalid");
  }
  return {
    account,
    document: {
      accountId: account.id,
      accountLabel: account.label,
      cancelCommand: login.next,
      method: expected.deviceCode ? "device_code" : "browser",
      type: "codex_device_login",
      ...(login.userCode === undefined ? {} : { userCode: login.userCode }),
      verificationUrl: url.toString(),
      version: 1,
    },
    idempotencyKey,
    kind: "handoff",
  };
};

export class ProtectedOutputFile {
  readonly #aclPolicy: ProtectedOutputAclPolicy;
  readonly #documentDescriptor: number;
  readonly #documentIdentity: FileIdentity;
  readonly #expectedOwnerUid: number;
  readonly #fileName: string;
  readonly #hooks: ProtectedOutputTestHooks;
  readonly #inspectDescriptorExtendedAcl: (
    descriptor: number,
  ) => ProtectedOutputAclInspection;
  readonly #loadNativeOpenAtLibrary: () => ProtectedOutputNativeOpenAtLibrary | null;
  readonly #parentDescriptor: number;
  readonly #parentIdentity: DirectoryIdentity;
  readonly #parentPath: string;
  #closed = false;

  constructor(path: string, hooks: ProtectedOutputTestHooks = {}) {
    if (
      !isAbsolute(path)
      || resolve(path) !== path
      || basename(path) === ""
      || dirname(path) === path
    ) throw new ProtectedOutputError("path_invalid");
    this.path = path;
    this.#parentPath = dirname(path);
    this.#fileName = basename(path);
    this.#expectedOwnerUid = hooks.expectedOwnerUid ?? ownerUid();
    this.#hooks = hooks;
    const aclPolicy = protectedOutputAclPolicyForPlatform(hooks.platform ?? process.platform);
    if (aclPolicy === null) throw new ProtectedOutputError("unsupported");
    this.#aclPolicy = aclPolicy;
    this.#inspectDescriptorExtendedAcl = hooks.inspectDescriptorExtendedAcl
      ?? inspectProtectedOutputDarwinDescriptorAcl;
    this.#loadNativeOpenAtLibrary = hooks.loadNativeOpenAtLibrary
      ?? loadProcessNativeOpenAtLibrary;
    let parentDescriptor: number | undefined;
    let documentDescriptor: number | undefined;
    try {
      parentDescriptor = openSync(
        this.#parentPath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      this.#parentIdentity = proveDirectory(
        this.#parentPath,
        parentDescriptor,
        this.#expectedOwnerUid,
      );
      hooks.beforeChildOpen?.();
      documentDescriptor = openChildAt(
        parentDescriptor,
        this.#fileName,
        constants.O_RDWR,
        this.#loadNativeOpenAtLibrary,
      );
      this.#documentIdentity = proveDocument(documentDescriptor, this.#expectedOwnerUid);
      if (fstatSync(documentDescriptor).size !== 0) {
        throw new ProtectedOutputError("file_not_empty");
      }
      proveChildBinding(
        parentDescriptor,
        this.#fileName,
        this.#documentIdentity,
        this.#expectedOwnerUid,
        this.#loadNativeOpenAtLibrary,
      );
      proveDescriptorAcl(
        parentDescriptor,
        this.#aclPolicy,
        this.#inspectDescriptorExtendedAcl,
        "parent_invalid",
      );
      proveDescriptorAcl(
        documentDescriptor,
        this.#aclPolicy,
        this.#inspectDescriptorExtendedAcl,
        "file_invalid",
      );
      this.#parentDescriptor = parentDescriptor;
      this.#documentDescriptor = documentDescriptor;
    } catch (error: unknown) {
      if (documentDescriptor !== undefined) closeSync(documentDescriptor);
      if (parentDescriptor !== undefined) closeSync(parentDescriptor);
      if (error instanceof ProtectedOutputError) throw error;
      throw new ProtectedOutputError("file_invalid");
    }
  }

  readonly path: string;

  close(): boolean {
    if (this.#closed) return true;
    this.#closed = true;
    let closed = true;
    try {
      closeSync(this.#documentDescriptor);
    } catch {
      closed = false;
    }
    try {
      closeSync(this.#parentDescriptor);
    } catch {
      closed = false;
    }
    return closed;
  }

  write(document: DeviceLoginDocument | ProtectedInteractionDetailDocument): void {
    if (this.#closed) throw new ProtectedOutputError("binding_changed");
    const protectedBytes = document.type === "hra_protected_interaction_detail"
      ? encodeProtectedInteractionDetailDocument(document)
      : null;
    const encoded = protectedBytes === null
      ? Buffer.from(`${JSON.stringify(document)}\n`, "utf8")
      : Buffer.from(
          protectedBytes.buffer,
          protectedBytes.byteOffset,
          protectedBytes.byteLength,
        );
    const observed = Buffer.alloc(encoded.byteLength);
    const eofProbe = Buffer.alloc(1);
    try {
      if (
        encoded.byteLength === 0
        || encoded.byteLength > (document.type === "hra_protected_interaction_detail"
          ? PROTECTED_INTERACTION_DETAIL_MAXIMUM_BYTES
          : DEVICE_LOGIN_DOCUMENT_MAXIMUM_BYTES)
      ) throw new ProtectedOutputError("document_invalid");
      this.#hooks.beforeWrite?.();
      this.#proveHeldEmptyBinding();
      let written = 0;
      while (written < encoded.byteLength) {
        const count = writeSync(
          this.#documentDescriptor,
          encoded,
          written,
          encoded.byteLength - written,
          written,
        );
        if (count <= 0) throw new ProtectedOutputError("write_unproven");
        written += count;
      }
      fsyncSync(this.#documentDescriptor);
      const count = readSync(
        this.#documentDescriptor,
        observed,
        0,
        observed.byteLength,
        0,
      );
      const extra = readSync(
        this.#documentDescriptor,
        eofProbe,
        0,
        1,
        observed.byteLength,
      );
      this.#hooks.beforePostflight?.();
      const postIdentity = proveDocument(this.#documentDescriptor, this.#expectedOwnerUid);
      proveChildBinding(
        this.#parentDescriptor,
        this.#fileName,
        this.#documentIdentity,
        this.#expectedOwnerUid,
        this.#loadNativeOpenAtLibrary,
      );
      const postParentIdentity = proveDirectory(
        this.#parentPath,
        this.#parentDescriptor,
        this.#expectedOwnerUid,
      );
      if (
        count !== encoded.byteLength
        || extra !== 0
        || !observed.equals(encoded)
        || !sameFile(this.#documentIdentity, postIdentity)
        || fstatSync(this.#documentDescriptor).size !== encoded.byteLength
        || !sameDirectory(this.#parentIdentity, postParentIdentity)
      ) throw new ProtectedOutputError("write_unproven");
      this.#proveNoExtendedAcl("write_unproven");
    } catch (error: unknown) {
      if (error instanceof ProtectedOutputError) throw error;
      throw new ProtectedOutputError("write_unproven");
    } finally {
      encoded.fill(0);
      observed.fill(0);
      eofProbe.fill(0);
    }
  }

  #proveHeldEmptyBinding(): void {
    if (!sameDirectory(
      this.#parentIdentity,
      proveDirectory(this.#parentPath, this.#parentDescriptor, this.#expectedOwnerUid),
    )) throw new ProtectedOutputError("binding_changed");
    if (!sameFile(
      this.#documentIdentity,
      proveDocument(this.#documentDescriptor, this.#expectedOwnerUid),
    )) throw new ProtectedOutputError("binding_changed");
    proveChildBinding(
      this.#parentDescriptor,
      this.#fileName,
      this.#documentIdentity,
      this.#expectedOwnerUid,
      this.#loadNativeOpenAtLibrary,
    );
    if (fstatSync(this.#documentDescriptor).size !== 0) {
      throw new ProtectedOutputError("file_not_empty");
    }
    this.#proveNoExtendedAcl("binding_changed");
  }

  #proveNoExtendedAcl(
    aclPresentCode: "binding_changed" | "write_unproven",
  ): void {
    proveDescriptorAcl(
      this.#parentDescriptor,
      this.#aclPolicy,
      this.#inspectDescriptorExtendedAcl,
      aclPresentCode,
    );
    proveDescriptorAcl(
      this.#documentDescriptor,
      this.#aclPolicy,
      this.#inspectDescriptorExtendedAcl,
      aclPresentCode,
    );
  }
}
