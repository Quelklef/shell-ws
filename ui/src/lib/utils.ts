const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function encodeId(prefix: string) {
  return `${prefix}-${encodeBase62(BigInt(Date.now()))}-${encodeBase62(randomU128())}`;
}

function randomU128() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

function encodeBase62(value: bigint) {
  if (value === 0n) {
    return "0";
  }
  let current = value;
  let encoded = "";
  while (current > 0n) {
    const digit = Number(current % 62n);
    encoded = BASE62[digit] + encoded;
    current /= 62n;
  }
  return encoded;
}

export function toBase64(bytes: Uint8Array) {
  let raw = "";
  for (let index = 0; index < bytes.length; index += 1) {
    raw += String.fromCharCode(bytes[index] ?? 0);
  }
  return btoa(raw);
}

export function fromBase64(base64: string) {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

export function concatBytes(current: Uint8Array, next: Uint8Array) {
  const merged = new Uint8Array(current.length + next.length);
  merged.set(current, 0);
  merged.set(next, current.length);
  return merged;
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
