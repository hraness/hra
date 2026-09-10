const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayName = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag);
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength");
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer");
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength");
const typedArraySet: Readonly<{
  value?: (this: Uint8Array, source: Uint8Array) => void;
}> | undefined = Object.getOwnPropertyDescriptor(typedArrayPrototype, "set");

export function snapshotUsageAccountKeyV2(input: Uint8Array): Uint8Array | null {
  try {
    if (
      typedArrayName?.get === undefined
      || typedArrayByteLength?.get === undefined
      || typedArrayBuffer?.get === undefined
      || arrayBufferByteLength?.get === undefined
      || typedArraySet?.value === undefined
      || typedArrayName.get.call(input) !== "Uint8Array"
      || typedArrayByteLength.get.call(input) !== 32
    ) return null;
    const buffer: unknown = typedArrayBuffer.get.call(input);
    // The ArrayBuffer getter rejects shared storage. A shared writer could
    // otherwise change the bytes during this synchronous snapshot.
    arrayBufferByteLength.get.call(buffer);
    const copied = new Uint8Array(32);
    // Native typed-array copying honors the view's offset without consulting
    // caller iterators, species, methods or shadowed byte-length accessors.
    typedArraySet.value.call(copied, input);
    return copied;
  } catch {
    return null;
  }
}
