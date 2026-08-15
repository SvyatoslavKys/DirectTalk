import { describe, expect, it } from "vitest";
import { parseAppPayload } from "./connection";
import { MAX_PHOTO_BYTES, photoChunkCount } from "./photos";

const id = "123e4567-e89b-42d3-a456-426614174000";

describe("photo packet validation", () => {
  it("accepts a consistent photo offer", () => {
    const offer = {
      kind: "photo-offer",
      id,
      name: "Фото.png",
      mime: "image/png",
      size: MAX_PHOTO_BYTES,
      sha256: "a".repeat(64),
      chunks: photoChunkCount(MAX_PHOTO_BYTES),
      createdAt: 1_700_000_000_000,
    };

    expect(parseAppPayload(offer)).toEqual(offer);
  });

  it("rejects offers with inconsistent metadata", () => {
    const base = {
      kind: "photo-offer",
      id,
      name: "photo.webp",
      mime: "image/webp",
      size: 8_000,
      sha256: "b".repeat(64),
      chunks: photoChunkCount(8_000),
      createdAt: 1_700_000_000_000,
    };

    expect(() => parseAppPayload({ ...base, chunks: base.chunks + 1 })).toThrow("некорректный пакет");
    expect(() => parseAppPayload({ ...base, mime: "image/svg+xml" })).toThrow("некорректный пакет");
    expect(() => parseAppPayload({ ...base, name: "../photo.webp" })).toThrow("некорректный пакет");
    expect(() => parseAppPayload({ ...base, sha256: "not-a-digest" })).toThrow("некорректный пакет");
  });

  it("validates chunk and cancellation packets", () => {
    const chunk = { kind: "photo-chunk", id, index: 0, data: "AQIDBA" };
    expect(parseAppPayload(chunk)).toEqual(chunk);
    expect(() => parseAppPayload({ ...chunk, index: -1 })).toThrow("некорректный пакет");
    expect(() => parseAppPayload({ ...chunk, data: "not+base64" })).toThrow("некорректный пакет");
    expect(parseAppPayload({ kind: "photo-cancel", id, reason: "hash-mismatch" })).toEqual({
      kind: "photo-cancel",
      id,
      reason: "hash-mismatch",
    });
  });

  it("validates deletion and consensual chat-clear packets", () => {
    expect(parseAppPayload({ kind: "delete-message", messageId: id })).toEqual({
      kind: "delete-message",
      messageId: id,
    });
    expect(parseAppPayload({ kind: "delete-message-result", messageId: id, deleted: true })).toEqual({
      kind: "delete-message-result",
      messageId: id,
      deleted: true,
    });
    expect(parseAppPayload({ kind: "clear-chat-request", id })).toEqual({ kind: "clear-chat-request", id });
    expect(parseAppPayload({ kind: "clear-chat-response", id, accepted: false })).toEqual({
      kind: "clear-chat-response",
      id,
      accepted: false,
    });
    expect(() => parseAppPayload({ kind: "delete-message", messageId: "demo-1" })).toThrow("некорректный пакет");
    expect(() => parseAppPayload({ kind: "clear-chat-response", id, accepted: "yes" })).toThrow("некорректный пакет");
  });
});
