import { dlopen } from "bun:ffi";

export type DescriptorAclInspection = "clear" | "present" | "indeterminate";

export type NativeDarwinAclLibrary = Readonly<{
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

type NativeDarwinAclLibraryOpener = (library: string) => NativeDarwinAclLibrary;

const openNativeDarwinAclLibrary: NativeDarwinAclLibraryOpener = (library) => dlopen(
  library,
  {
    fgetattrlist: {
      args: ["i32", "ptr", "ptr", "usize", "usize"],
      returns: "i32",
    },
  },
);

const DARWIN_ATTR_BIT_MAP_COUNT = 5;
const DARWIN_ATTR_CMN_EXTENDED_SECURITY = 0x00400000;
const DARWIN_ATTR_CMN_RETURNED_ATTRS = 0x80000000;
const DARWIN_ATTR_CMN_ACL_REQUEST = (
  DARWIN_ATTR_CMN_RETURNED_ATTRS | DARWIN_ATTR_CMN_EXTENDED_SECURITY
) >>> 0;
const DARWIN_FSOPT_REPORT_FULLSIZE = 0x00000004;
const DARWIN_ATTR_LIST_BYTES = 24;
const DARWIN_ATTR_RESULT_BYTES = 32;

export const parseDarwinDescriptorAclResult = (
  returnCode: number,
  result: Uint8Array,
): DescriptorAclInspection => {
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
  if (
    words[2] !== 0
    || words[3] !== 0
    || words[4] !== 0
    || words[5] !== 0
  ) return "indeterminate";
  if (words[1] === DARWIN_ATTR_CMN_ACL_REQUEST) return "present";
  if (
    words[0] !== DARWIN_ATTR_RESULT_BYTES
    || words[1] !== DARWIN_ATTR_CMN_RETURNED_ATTRS
    || words[6] !== 0
    || words[7] !== 0
  ) return "indeterminate";
  return "clear";
};

export const loadNativeDarwinAclLibrary = (
  platform: NodeJS.Platform,
  openLibrary: NativeDarwinAclLibraryOpener = openNativeDarwinAclLibrary,
): NativeDarwinAclLibrary | null => {
  if (platform !== "darwin") return null;
  try {
    return openLibrary("/usr/lib/libSystem.B.dylib");
  } catch {
    return null;
  }
};

let processNativeDarwinAclLibrary: NativeDarwinAclLibrary | null | undefined;

export const inspectDarwinDescriptorAcl = (
  descriptor: number,
  loadLibrary: () => NativeDarwinAclLibrary | null = () => {
    if (processNativeDarwinAclLibrary === undefined) {
      processNativeDarwinAclLibrary = loadNativeDarwinAclLibrary(process.platform);
    }
    return processNativeDarwinAclLibrary;
  },
): DescriptorAclInspection => {
  let library: NativeDarwinAclLibrary | null;
  try {
    library = loadLibrary();
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
  try {
    return parseDarwinDescriptorAclResult(
      library.symbols.fgetattrlist(
        descriptor,
        attributes,
        result,
        result.byteLength,
        DARWIN_FSOPT_REPORT_FULLSIZE,
      ),
      result,
    );
  } catch {
    return "indeterminate";
  } finally {
    attributes.fill(0);
    result.fill(0);
  }
};

export type DescriptorAclPolicy = Readonly<{
  inspectDarwinAcl?: (descriptor: number) => DescriptorAclInspection;
  platform?: NodeJS.Platform;
}>;

export const proveDescriptorAclAbsence = (
  descriptor: number,
  policy: DescriptorAclPolicy,
  message: string,
): void => {
  const platform = policy.platform ?? process.platform;
  if (platform === "linux") return;
  if (platform !== "darwin") throw new Error(message);
  const inspect = policy.inspectDarwinAcl ?? inspectDarwinDescriptorAcl;
  let inspection: DescriptorAclInspection;
  try {
    inspection = inspect(descriptor);
  } catch {
    throw new Error(message);
  }
  if (inspection !== "clear") throw new Error(message);
};
