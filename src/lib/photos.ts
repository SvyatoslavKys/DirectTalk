import { base64UrlDecode, base64UrlEncode, bytesToHex } from "./encoding";

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const PHOTO_CHUNK_BYTES = 7 * 1024;
export const MAX_PHOTO_CHUNKS = Math.ceil(MAX_PHOTO_BYTES / PHOTO_CHUNK_BYTES);
export const MAX_PHOTO_CHUNK_TEXT = Math.ceil((PHOTO_CHUNK_BYTES * 4) / 3) + 4;

export const PHOTO_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export type PhotoMimeType = (typeof PHOTO_MIME_TYPES)[number];

export interface PhotoFileMetadata {
  name: string;
  mime: PhotoMimeType;
  size: number;
}

export function isPhotoMimeType(value: unknown): value is PhotoMimeType {
  return typeof value === "string" && PHOTO_MIME_TYPES.includes(value as PhotoMimeType);
}

export function normalizePhotoName(value: string): string {
  const normalized = value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f/\\]/gu, "_")
    .trim();
  return (normalized || "photo").slice(0, 120);
}

export function isSafePhotoName(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 120 && normalizePhotoName(value) === value;
}

export function validatePhotoFile(file: Pick<File, "name" | "type" | "size">): PhotoFileMetadata {
  if (!isPhotoMimeType(file.type)) throw new Error("Можно отправлять только JPEG, PNG, WebP или GIF.");
  if (!Number.isSafeInteger(file.size) || file.size < 1) throw new Error("Выбран пустой или некорректный файл.");
  if (file.size > MAX_PHOTO_BYTES) throw new Error("Размер фотографии не должен превышать 10 МБ.");
  return { name: normalizePhotoName(file.name), mime: file.type, size: file.size };
}

export function photoChunkCount(size: number): number {
  return Math.ceil(size / PHOTO_CHUNK_BYTES);
}

export function expectedPhotoChunkBytes(size: number, index: number): number {
  const total = photoChunkCount(size);
  if (!Number.isSafeInteger(index) || index < 0 || index >= total) return 0;
  return index === total - 1 ? size - index * PHOTO_CHUNK_BYTES : PHOTO_CHUNK_BYTES;
}

export async function hashPhoto(blob: Blob): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
}

export async function validatePhotoSignature(blob: Blob, mime: PhotoMimeType): Promise<void> {
  const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const matches =
    (mime === "image/jpeg" && startsWith(header, [0xff, 0xd8, 0xff])) ||
    (mime === "image/png" && startsWith(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
    (mime === "image/gif" && (startsWithAscii(header, "GIF87a") || startsWithAscii(header, "GIF89a"))) ||
    (mime === "image/webp" && startsWithAscii(header, "RIFF") && startsWithAscii(header.slice(8), "WEBP"));
  if (!matches) throw new Error("Содержимое файла не соответствует заявленному формату фотографии.");
}

export async function encodePhotoChunk(blob: Blob, index: number): Promise<string> {
  const start = index * PHOTO_CHUNK_BYTES;
  const end = Math.min(start + PHOTO_CHUNK_BYTES, blob.size);
  if (start < 0 || start >= end) throw new Error("Некорректный номер части фотографии");
  return base64UrlEncode(await blob.slice(start, end).arrayBuffer());
}

export function decodePhotoChunk(value: string): Uint8Array<ArrayBuffer> {
  if (value.length < 1 || value.length > MAX_PHOTO_CHUNK_TEXT) throw new Error("Некорректный размер части фотографии");
  return base64UrlDecode(value);
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function startsWith(value: Uint8Array<ArrayBuffer>, expected: number[]): boolean {
  return expected.every((byte, index) => value[index] === byte);
}

function startsWithAscii(value: Uint8Array<ArrayBuffer>, expected: string): boolean {
  return [...expected].every((character, index) => value[index] === character.charCodeAt(0));
}
