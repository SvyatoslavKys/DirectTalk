import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logDiagnostic } from "./diagnostics";
import { rtcConfiguration } from "./config";

vi.mock("./diagnostics", () => ({
  logDiagnostic: vi.fn(),
  safeErrorText: (value: unknown) => String(value),
}));

const FALLBACK_STUN_URL = "stun:fallback.example:3478";

beforeEach(() => {
  vi.stubEnv("VITE_STUN_URL", FALLBACK_STUN_URL);
  vi.stubGlobal("window", {
    location: {
      hostname: "chat.example",
      host: "chat.example",
      protocol: "https:",
    },
    setTimeout,
    clearTimeout,
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("rtcConfiguration", () => {
  it("recognizes the public test provider and retains the fallback STUN server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          provider: "open-relay-test",
          iceServers: [
            {
              urls: ["stun:provider.example:3478", "turn:relay.example:3478?transport=udp"],
              username: "ephemeral-user",
              credential: "ephemeral-secret",
            },
          ],
        }),
      }),
    );

    const configuration = await rtcConfiguration();

    expect(configuration).toEqual({
      bundlePolicy: "max-bundle",
      iceServers: [
        {
          urls: ["stun:provider.example:3478", "turn:relay.example:3478?transport=udp"],
          username: "ephemeral-user",
          credential: "ephemeral-secret",
        },
        { urls: FALLBACK_STUN_URL },
      ],
    });
    expect(logDiagnostic).toHaveBeenCalledWith("turn", "credentials-ready", {
      provider: "open-relay-test",
      serverCount: 2,
      relayConfigured: true,
    });
    expect(JSON.stringify(vi.mocked(logDiagnostic).mock.calls)).not.toContain("ephemeral-user");
    expect(JSON.stringify(vi.mocked(logDiagnostic).mock.calls)).not.toContain("ephemeral-secret");
  });

  it("does not duplicate the fallback STUN URL already returned by the endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          provider: "metered",
          iceServers: [
            {
              urls: [FALLBACK_STUN_URL, "turns:relay.example:443?transport=tcp"],
              username: "user",
              credential: "credential",
            },
          ],
        }),
      }),
    );

    const configuration = await rtcConfiguration();
    const configuredUrls = configuration.iceServers?.flatMap((server) =>
      typeof server.urls === "string" ? [server.urls] : server.urls,
    );

    expect(configuredUrls?.filter((url) => url === FALLBACK_STUN_URL)).toHaveLength(1);
    expect(configuration.iceServers).toHaveLength(1);
    expect(logDiagnostic).toHaveBeenCalledWith("turn", "credentials-ready", {
      provider: "metered",
      serverCount: 1,
      relayConfigured: true,
    });
  });

  it("uses only the fallback STUN server when fetching TURN credentials fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unavailable")));

    await expect(rtcConfiguration()).resolves.toEqual({
      bundlePolicy: "max-bundle",
      iceServers: [{ urls: FALLBACK_STUN_URL }],
    });
    expect(logDiagnostic).toHaveBeenCalledWith(
      "turn",
      "credentials-failed",
      { reason: "Error: network unavailable" },
      "warn",
    );
  });
});
