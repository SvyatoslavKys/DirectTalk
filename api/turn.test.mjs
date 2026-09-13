import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createOpenRelayTestCredentials,
  extractIceServers,
  sanitizeIceServers,
  validateMeteredCredentialsUrl,
} from "./turn.mjs";

const meteredServers = [
  { urls: "stun:stun.relay.metered.ca:80" },
  {
    urls: ["turn:global.relay.metered.ca:80", "turns:global.relay.metered.ca:443?transport=tcp"],
    username: "temporary-user",
    credential: "temporary-password",
  },
];

describe("Metered TURN response handling", () => {
  it("accepts the iceServers array returned by the Open Relay endpoint", () => {
    expect(sanitizeIceServers(extractIceServers(meteredServers))).toEqual(meteredServers);
  });

  it("keeps compatibility with an object containing iceServers", () => {
    expect(extractIceServers({ iceServers: meteredServers })).toEqual(meteredServers);
  });

  it("allows only the expected Metered credentials endpoint", () => {
    expect(validateMeteredCredentialsUrl("https://directtalk.metered.live/api/v1/turn/credentials")).toBe(
      "https://directtalk.metered.live/api/v1/turn/credentials",
    );
    expect(() =>
      validateMeteredCredentialsUrl(
        "https://directtalk.metered.live/api/v1/turn/credentials?apiKey=must-not-be-embedded",
      ),
    ).toThrow("Invalid Metered TURN credentials URL");
    expect(() => validateMeteredCredentialsUrl("https://example.com/api/v1/turn/credentials")).toThrow(
      "Invalid Metered TURN credentials URL",
    );
  });

  it("creates one-hour credentials for the official public static-auth test relay", () => {
    const result = createOpenRelayTestCredentials(1_700_000_000);
    const turnServer = result.iceServers[1];
    expect(result.ttl).toBe(3_600);
    expect(turnServer.username).toBe("1700003600");
    expect(turnServer.credential).toBe(
      createHmac("sha1", "openrelayprojectsecret").update("1700003600").digest("base64"),
    );
    expect(turnServer.urls).toContain("turn:staticauth.openrelay.metered.ca:80?transport=udp");
    expect(turnServer.urls).toContain("turns:staticauth.openrelay.metered.ca:443?transport=tcp");
  });
});
