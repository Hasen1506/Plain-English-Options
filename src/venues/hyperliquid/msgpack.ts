// Minimal MessagePack encoder, byte-compatible with Python `msgpack.packb`
// (msgpack >= 1.0 defaults: use_bin_type=True, str8 allowed, smallest int
// encoding, map key order preserved). Hyperliquid hashes L1 actions as
// keccak(msgpack(action) ‖ nonce ‖ vault flag …), so one byte of difference is
// a different signer on the exchange. Only the types an action can contain
// are supported: null, boolean, integer, string, bytes, array, plain object.
// Floats are refused on purpose: every price and size goes on the wire as a string.

export type Packable = null | boolean | number | bigint | string | Uint8Array | Packable[] | { [k: string]: Packable | undefined };

const te = new TextEncoder();

export function packb(v: Packable): Uint8Array {
  const out: number[] = [];
  enc(v, out);
  return Uint8Array.from(out);
}

function u(out: number[], n: bigint | number, bytes: number) {
  let x = BigInt(n);
  const tmp: number[] = [];
  for (let i = 0; i < bytes; i++) {
    tmp.push(Number(x & 0xffn));
    x >>= 8n;
  }
  for (let i = bytes - 1; i >= 0; i--) out.push(tmp[i]!);
}

/** A type byte followed by a big-endian length/value of `bytes` bytes. */
function tag(out: number[], t: number, n: bigint | number, bytes: number) {
  out.push(t);
  u(out, n, bytes);
}

function encInt(x: bigint, out: number[]) {
  if (x >= 0n) {
    if (x < 128n) out.push(Number(x));
    else if (x < 256n) out.push(0xcc, Number(x));
    else if (x < 65536n) tag(out, 0xcd, x, 2);
    else if (x < 4294967296n) tag(out, 0xce, x, 4);
    else if (x < 18446744073709551616n) tag(out, 0xcf, x, 8);
    else throw new Error("integer too large for msgpack");
  } else {
    if (x >= -32n) out.push(Number(x & 0xffn));
    else if (x >= -128n) out.push(0xd0, Number(x & 0xffn));
    else if (x >= -32768n) tag(out, 0xd1, x & 0xffffn, 2);
    else if (x >= -2147483648n) tag(out, 0xd2, x & 0xffffffffn, 4);
    else if (x >= -9223372036854775808n) tag(out, 0xd3, x & 0xffffffffffffffffn, 8);
    else throw new Error("integer too small for msgpack");
  }
}

function enc(v: Packable | undefined, out: number[]) {
  if (v === null || v === undefined) return void out.push(0xc0);
  if (v === true) return void out.push(0xc3);
  if (v === false) return void out.push(0xc2);
  if (typeof v === "bigint") return encInt(v, out);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error(`msgpack: refusing non-integer number ${v} (send prices and sizes as strings)`);
    return encInt(BigInt(v), out);
  }
  if (typeof v === "string") {
    const b = te.encode(v);
    const n = b.length;
    if (n < 32) out.push(0xa0 | n);
    else if (n < 256) out.push(0xd9, n);
    else if (n < 65536) tag(out, 0xda, n, 2);
    else tag(out, 0xdb, n, 4);
    for (const x of b) out.push(x);
    return;
  }
  if (v instanceof Uint8Array) {
    const n = v.length;
    if (n < 256) out.push(0xc4, n);
    else if (n < 65536) tag(out, 0xc5, n, 2);
    else tag(out, 0xc6, n, 4);
    for (const x of v) out.push(x);
    return;
  }
  if (Array.isArray(v)) {
    const n = v.length;
    if (n < 16) out.push(0x90 | n);
    else if (n < 65536) tag(out, 0xdc, n, 2);
    else tag(out, 0xdd, n, 4);
    for (const x of v) enc(x, out);
    return;
  }
  // plain object: key order as inserted (Python dicts keep insertion order too).
  // undefined values are skipped, like a key that was never set.
  const entries = Object.entries(v).filter(([, x]) => x !== undefined);
  const n = entries.length;
  if (n < 16) out.push(0x80 | n);
  else if (n < 65536) tag(out, 0xde, n, 2);
  else tag(out, 0xdf, n, 4);
  for (const [k, x] of entries) {
    enc(k, out);
    enc(x, out);
  }
}
