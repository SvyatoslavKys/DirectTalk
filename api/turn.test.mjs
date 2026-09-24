import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configuredProviders,
  createOpenRelayTestCredentials,
  extractIceServers,
  resolveProviderCredentials,
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

const cloudflareServers = [
  { urls: "stun:stun.cloudflare.com:3478" },
  {
    urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"],
    username: "cloudflare-temporary-user",
    credential: "cloudflare-temporary-password",
  },
];

afterEach(() => {
  vi.unstubAllEnvs();
});

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

  it("deduplicates ICE URLs within and across server entries", () => {
    expect(sanitizeIceServers([
      { urls: ["stun:shared.example:3478", "stun:shared.example:3478", "turn:one.example:3478"] },
      { urls: ["stun:shared.example:3478", "turn:two.example:3478"] },
    ])).toEqual([
      { urls: ["stun:shared.example:3478", "turn:one.example:3478"] },
      { urls: ["turn:two.example:3478"] },
    ]);
  });

  it("preserves the same TURN URL when credentials differ", () => {
    expect(sanitizeIceServers([
      { urls: "turn:shared.example:3478", username: "first-user", credential: "first-password" },
      { urls: "turn:shared.example:3478", username: "second-user", credential: "second-password" },
    ])).toEqual([
      { urls: "turn:shared.example:3478", username: "first-user", credential: "first-password" },
      { urls: "turn:shared.example:3478", username: "second-user", credential: "second-password" },
    ]);
  });

  it("rejects oversized per-server and per-provider ICE URL lists", () => {
    expect(() => sanitizeIceServers([{
      urls: Array.from({ length: 9 }, (_, index) => `turn:server-${index}.example:3478`),
    }])).toThrow("Too many ICE URLs");
    expect(() => sanitizeIceServers([
      { urls: Array.from({ length: 7 }, (_, index) => `turn:first-${index}.example:3478`) },
      { urls: Array.from({ length: 6 }, (_, index) => `turn:second-${index}.example:3478`) },
    ])).toThrow("Too many ICE URLs");
  });
});

describe("TURN provider configuration", () => {
  it("uses the public test relay only when no private provider is configured", () => {
    clearPrivateProviderEnvironment();

    expect(configuredProviders().map((provider) => provider.name)).toEqual(["open-relay-test"]);
  });

  it("disables the public test relay when both private providers are configured", () => {
    configureMetered();
    configureCloudflare();

    expect(configuredProviders().map((provider) => provider.name)).toEqual(["metered", "cloudflare"]);
  });

  it("uses either private provider without adding the public test relay", () => {
    clearPrivateProviderEnvironment();
    configureCloudflare();

    expect(configuredProviders().map((provider) => provider.name)).toEqual(["cloudflare"]);
  });

  it("rejects a partially configured private provider instead of silently using the public relay", () => {
    clearPrivateProviderEnvironment();
    vi.stubEnv("METERED_TURN_API_KEY", "metered-api-key");

    expect(() => configuredProviders()).toThrow("Incomplete Metered TURN configuration");
  });
});

describe("TURN provider aggregation", () => {
  it("combines sanitized ICE servers from every successful private provider", async () => {
    const metered = mockProvider("metered", {
      iceServers: [
        ...meteredServers,
        { urls: ["https://unsupported.example", "turn:global.relay.metered.ca:443?transport=tcp"] },
      ],
    }, "metered-long-lived-api-key");
    const cloudflare = mockProvider("cloudflare", {
      iceServers: cloudflareServers,
      ttl: 21_600,
    }, "cloudflare-long-lived-api-token");

    const result = await resolveProviderCredentials([metered, cloudflare], 1_234);

    expect(result).toEqual({
      provider: "metered+cloudflare",
      iceServers: [
        ...meteredServers,
        { urls: ["turn:global.relay.metered.ca:443?transport=tcp"] },
        ...cloudflareServers,
      ],
    });
    expect(metered.credentials).toHaveBeenCalledWith(1_234);
    expect(cloudflare.credentials).toHaveBeenCalledWith(1_234);
    expect(JSON.stringify(result)).not.toContain("metered-long-lived-api-key");
    expect(JSON.stringify(result)).not.toContain("cloudflare-long-lived-api-token");
  });

  it("returns Cloudflare when Metered fails", async () => {
    const metered = mockRejectedProvider("metered");
    const cloudflare = mockProvider("cloudflare", { iceServers: cloudflareServers, ttl: 21_600 });

    await expect(resolveProviderCredentials([metered, cloudflare])).resolves.toEqual({
      provider: "cloudflare",
      iceServers: cloudflareServers,
      ttl: 21_600,
    });
    expect(metered.credentials).toHaveBeenCalledWith(4_000);
    expect(cloudflare.credentials).toHaveBeenCalledWith(4_000);
  });

  it("returns Metered when Cloudflare fails", async () => {
    const metered = mockProvider("metered", { iceServers: meteredServers });
    const cloudflare = mockRejectedProvider("cloudflare");

    await expect(resolveProviderCredentials([metered, cloudflare])).resolves.toEqual({
      provider: "metered",
      iceServers: meteredServers,
    });
  });

  it("ignores a provider response without a usable TURN URL", async () => {
    const metered = mockProvider("metered", { iceServers: [{ urls: "stun:stun.example:3478" }] });
    const cloudflare = mockProvider("cloudflare", { iceServers: cloudflareServers });

    await expect(resolveProviderCredentials([metered, cloudflare])).resolves.toEqual({
      provider: "cloudflare",
      iceServers: cloudflareServers,
    });
  });

  it("deduplicates shared URLs across successful providers", async () => {
    const metered = mockProvider("metered", {
      iceServers: [{ urls: ["stun:shared.example:3478", "turn:metered.example:3478"] }],
    });
    const cloudflare = mockProvider("cloudflare", {
      iceServers: [{ urls: ["stun:shared.example:3478", "turn:cloudflare.example:3478"] }],
    });

    await expect(resolveProviderCredentials([metered, cloudflare])).resolves.toEqual({
      provider: "metered+cloudflare",
      iceServers: [
        { urls: ["stun:shared.example:3478", "turn:metered.example:3478"] },
        { urls: ["turn:cloudflare.example:3478"] },
      ],
    });
  });

  it("keeps a shared TURN endpoint from both providers when credentials differ", async () => {
    const sharedUrl = "turn:shared.example:3478";
    const metered = mockProvider("metered", {
      iceServers: [{ urls: sharedUrl, username: "metered-user", credential: "metered-password" }],
    });
    const cloudflare = mockProvider("cloudflare", {
      iceServers: [{ urls: sharedUrl, username: "cloudflare-user", credential: "cloudflare-password" }],
    });

    await expect(resolveProviderCredentials([metered, cloudflare])).resolves.toEqual({
      provider: "metered+cloudflare",
      iceServers: [
        { urls: sharedUrl, username: "metered-user", credential: "metered-password" },
        { urls: sharedUrl, username: "cloudflare-user", credential: "cloudflare-password" },
      ],
    });
  });

  it("returns null without leaking provider failures when every provider fails", async () => {
    const metered = mockRejectedProvider("metered", new Error("metered-api-key-secret"));
    const cloudflare = mockRejectedProvider("cloudflare", new Error("cloudflare-api-token-secret"));

    await expect(resolveProviderCredentials([metered, cloudflare])).resolves.toBeNull();
  });
});

function clearPrivateProviderEnvironment() {
  vi.stubEnv("METERED_TURN_CREDENTIALS_URL", "");
  vi.stubEnv("METERED_TURN_API_KEY", "");
  vi.stubEnv("CLOUDFLARE_TURN_KEY_ID", "");
  vi.stubEnv("CLOUDFLARE_TURN_API_TOKEN", "");
}

function configureMetered() {
  vi.stubEnv("METERED_TURN_CREDENTIALS_URL", "https://directtalk.metered.live/api/v1/turn/credentials");
  vi.stubEnv("METERED_TURN_API_KEY", "metered-api-key");
}

function configureCloudflare() {
  vi.stubEnv("CLOUDFLARE_TURN_KEY_ID", "cloudflare-key-id");
  vi.stubEnv("CLOUDFLARE_TURN_API_TOKEN", "cloudflare-api-token");
}

function mockProvider(name, result, rateLimitSecret = `${name}-rate-limit-secret`) {
  return {
    name,
    rateLimitSecret,
    credentials: vi.fn().mockResolvedValue(result),
  };
}

function mockRejectedProvider(name, error = new Error(`${name} unavailable`)) {
  return {
    name,
    rateLimitSecret: `${name}-rate-limit-secret`,
    credentials: vi.fn().mockRejectedValue(error),
  };
}
