const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function utf8(value: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(value);
}

export function fromUtf8(value: ArrayBuffer | Uint8Array<ArrayBufferLike>): string {
  return decoder.decode(value);
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function concatBytes(
  ...parts: Array<ArrayBuffer | Uint8Array<ArrayBufferLike>>
): Uint8Array<ArrayBuffer> {
  const views = parts.map((part) => (part instanceof Uint8Array ? part : new Uint8Array(part)));
  const result = new Uint8Array(views.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of views) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export function base64UrlEncode(value: ArrayBuffer | Uint8Array<ArrayBufferLike>): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) throw new Error("Некорректный base64url");
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
  return result;
}

export function bytesToHex(value: ArrayBuffer | Uint8Array<ArrayBufferLike>): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
