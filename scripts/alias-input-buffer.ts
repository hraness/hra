export const aliasInputMaximumBytes = 32 * 1024;

// This bounded byte reader owns no filesystem capability. Its caller supplies
// the descriptor read and retains descriptor custody; failed buffers are scrubbed here.
export const readAliasInputBuffer = (
  size: number,
  read: (buffer: Buffer, offset: number) => number,
): Buffer => {
  if (!Number.isSafeInteger(size) || size < 1 || size > aliasInputMaximumBytes) {
    throw new Error("alias_input_size_invalid");
  }
  const document = Buffer.alloc(size + 1);
  try {
    let offset = 0;
    while (offset < document.byteLength) {
      const count = read(document, offset);
      if (!Number.isSafeInteger(count) || count < 0 || count > document.byteLength - offset) {
        throw new Error("alias_input_read_invalid");
      }
      if (count === 0) break;
      offset += count;
    }
    if (offset !== size) throw new Error("alias_input_read_invalid");
    return document;
  } catch (error: unknown) {
    document.fill(0);
    throw error;
  }
};
