import { describe, expect, it } from "vitest";
import { isSignalPayload } from "./signaling.mjs";

const generation = "AbCdEfGhIjKlMn01";

describe("signaling ICE generation envelopes", () => {
  it("accepts descriptions, candidates and end-of-candidates with a generation", () => {
    expect(isSignalPayload({ description: { type: "offer", sdp: "v=0" }, iceGeneration: generation })).toBe(true);
    expect(isSignalPayload({ candidate: { candidate: "candidate:1 1 udp 1 192.0.2.1 5000 typ host" }, iceGeneration: generation })).toBe(true);
    expect(isSignalPayload({ candidate: { candidate: "" }, iceGeneration: generation })).toBe(true);
  });

  it("retains compatibility with legacy envelopes and rejects ambiguous generations", () => {
    expect(isSignalPayload({ description: { type: "answer", sdp: "v=0" } })).toBe(true);
    expect(isSignalPayload({ candidate: { candidate: "" } })).toBe(true);
    expect(isSignalPayload({ candidate: { candidate: "" }, iceGeneration: "too-short" })).toBe(false);
    expect(isSignalPayload({ description: { type: "offer", sdp: "v=0" }, candidate: { candidate: "" } })).toBe(false);
    expect(isSignalPayload({ iceGeneration: generation })).toBe(false);
    expect(isSignalPayload({ candidate: { candidate: "" }, unknown: true })).toBe(false);
    expect(isSignalPayload({ candidate: { candidate: "" }, iceGeneration: generation, unknown: true })).toBe(false);
  });
});
