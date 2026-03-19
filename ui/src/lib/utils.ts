export function encodeId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
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
