/**
 * Bytes → string, one character per byte (code point = byte value).
 *
 * Not `new TextDecoder("latin1")`: under the WHATWG Encoding standard that
 * label means windows-1252, so 0x95 decodes to "•" (U+2022) — and Node
 * versions disagree on whether they follow it (Node 22 does, Node 25 does
 * not). The PDF tests look for the raw WinAnsi bytes, so they passed on one
 * machine and failed in CI.
 */
export function latin1(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}
