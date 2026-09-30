import { describe, expect, it } from "vitest";
import { base64UrlEncode, randomBytes } from "./encoding";
import {
  decodeReconnectSecret,
  parseReconnectCapability,
  reconnectInvitation,
  type ReconnectCapability,
} from "./reconnect";

function capability(): ReconnectCapability {
  return {
    version: 1,
    roomId: base64UrlEncode(randomBytes(16)),
    secret: base64UrlEncode(randomBytes(32)),
    creatorIdentity: base64UrlEncode(randomBytes(65)),
    role: "joiner",
  };
}

describe("reconnect capability", () => {
  it("validates storage data and exposes only invitation fields to signaling setup", () => {
    const value = capability();

    expect(parseReconnectCapability(value)).toEqual(value);
    expect(decodeReconnectSecret(value)).toHaveLength(32);
    expect(reconnectInvitation(value)).toEqual({
      version: value.version,
      roomId: value.roomId,
      secret: value.secret,
      creatorIdentity: value.creatorIdentity,
    });
  });

  it("rejects malformed persisted capabilities", () => {
    const value = capability();
    expect(() => parseReconnectCapability({ ...value, secret: base64UrlEncode(randomBytes(31)) })).toThrow();
    expect(() => parseReconnectCapability({ ...value, creatorIdentity: "not-base64!" })).toThrow();
    expect(() => parseReconnectCapability({ ...value, role: "observer" })).toThrow();
  });
});
