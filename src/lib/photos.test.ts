import { describe, expect, it } from "vitest";
import {
  MAX_PHOTO_BYTES,
  PHOTO_CHUNK_BYTES,
  decodePhotoChunk,
  encodePhotoChunk,
  expectedPhotoChunkBytes,
  hashPhoto,
  normalizePhotoName,
  photoChunkCount,
  validatePhotoFile,
  validatePhotoSignature,
} from "./photos";

describe("photo transfer helpers", () => {
  it("normalizes file names before showing or downloading them", () => {
    expect(normalizePhotoName("  holiday/sea\\view\u0000.png  ")).toBe("holiday_sea_view_.png");
    expect(normalizePhotoName("   ")).toBe("photo");
    expect(normalizePhotoName("x".repeat(140))).toHaveLength(120);
  });

  it("accepts supported images and rejects unsafe sizes and formats", () => {
    expect(validatePhotoFile({ name: "pic.png", type: "image/png", size: 42 })).toEqual({
      name: "pic.png",
      mime: "image/png",
      size: 42,
    });
    expect(() => validatePhotoFile({ name: "pic.svg", type: "image/svg+xml", size: 42 })).toThrow("JPEG");
    expect(() => validatePhotoFile({ name: "empty.png", type: "image/png", size: 0 })).toThrow("пустой");
    expect(() => validatePhotoFile({ name: "huge.png", type: "image/png", size: MAX_PHOTO_BYTES + 1 })).toThrow("10 МБ");
  });

  it("splits and restores binary data without changing it", async () => {
    const original = new Uint8Array(PHOTO_CHUNK_BYTES * 2 + 17);
    for (let index = 0; index < original.length; index += 1) original[index] = index % 251;
    const blob = new Blob([original], { type: "image/png" });

    expect(photoChunkCount(blob.size)).toBe(3);
    expect(expectedPhotoChunkBytes(blob.size, 0)).toBe(PHOTO_CHUNK_BYTES);
    expect(expectedPhotoChunkBytes(blob.size, 2)).toBe(17);
    expect(expectedPhotoChunkBytes(blob.size, 3)).toBe(0);

    const restored: Uint8Array<ArrayBuffer>[] = [];
    for (let index = 0; index < photoChunkCount(blob.size); index += 1) {
      restored.push(decodePhotoChunk(await encodePhotoChunk(blob, index)));
    }
    const restoredBlob = new Blob(restored);

    expect(new Uint8Array(await restoredBlob.arrayBuffer())).toEqual(original);
    expect(await hashPhoto(restoredBlob)).toBe(await hashPhoto(blob));
  });

  it("computes the expected SHA-256 digest", async () => {
    await expect(hashPhoto(new Blob(["abc"]))).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("checks that file contents match the claimed safe image type", async () => {
    await expect(validatePhotoSignature(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])]), "image/jpeg")).resolves.toBeUndefined();
    await expect(validatePhotoSignature(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]), "image/png")).resolves.toBeUndefined();
    await expect(validatePhotoSignature(new Blob(["GIF89a"]), "image/gif")).resolves.toBeUndefined();
    await expect(validatePhotoSignature(new Blob(["RIFF0000WEBP"]), "image/webp")).resolves.toBeUndefined();
    await expect(validatePhotoSignature(new Blob(["<svg></svg>"]), "image/png")).rejects.toThrow("не соответствует");
  });
});
