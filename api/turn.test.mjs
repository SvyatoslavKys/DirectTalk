import { describe, expect, it } from "vitest";
import { extractIceServers, sanitizeIceServers, validateMeteredCredentialsUrl } from "./turn.mjs";

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
});
