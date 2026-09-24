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
  vi.useRealTimers();
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

  it("recognizes combined private-provider metadata and keeps both TURN configurations", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          provider: "metered+cloudflare",
          iceServers: [
            {
              urls: [FALLBACK_STUN_URL, "turn:metered.example:443?transport=tcp"],
              username: "metered-user",
              credential: "metered-credential",
            },
            {
              urls: [FALLBACK_STUN_URL, "turns:cloudflare.example:443?transport=tcp"],
              username: "cloudflare-user",
              credential: "cloudflare-credential",
            },
          ],
        }),
      }),
    );

    const configuration = await rtcConfiguration();

    expect(configuration.iceServers).toEqual([
      {
        urls: [FALLBACK_STUN_URL, "turn:metered.example:443?transport=tcp"],
        username: "metered-user",
        credential: "metered-credential",
      },
      {
        urls: ["turns:cloudflare.example:443?transport=tcp"],
        username: "cloudflare-user",
        credential: "cloudflare-credential",
      },
    ]);
    expect(logDiagnostic).toHaveBeenCalledWith("turn", "credentials-ready", {
      provider: "metered+cloudflare",
      serverCount: 2,
      relayConfigured: true,
    });
    expect(JSON.stringify(vi.mocked(logDiagnostic).mock.calls)).not.toContain("metered-credential");
    expect(JSON.stringify(vi.mocked(logDiagnostic).mock.calls)).not.toContain("cloudflare-credential");
  });

  it("rejects oversized ICE URL arrays and falls back to STUN", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          provider: "metered",
          iceServers: [{
            urls: Array.from({ length: 9 }, (_, index) => `turn:relay-${index}.example:3478`),
            username: "user",
            credential: "credential",
          }],
        }),
      }),
    );

    await expect(rtcConfiguration()).resolves.toEqual({
      bundlePolicy: "max-bundle",
      iceServers: [{ urls: FALLBACK_STUN_URL }],
    });
    expect(logDiagnostic).toHaveBeenCalledWith(
      "turn",
      "credentials-failed",
      { reason: "Error: Too many TURN URLs" },
      "warn",
    );
  });

  it("preserves a shared TURN URL when provider credentials differ", async () => {
    const sharedUrl = "turn:shared.example:3478";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          provider: "metered+cloudflare",
          iceServers: [
            { urls: sharedUrl, username: "metered-user", credential: "metered-password" },
            { urls: sharedUrl, username: "cloudflare-user", credential: "cloudflare-password" },
          ],
        }),
      }),
    );

    const configuration = await rtcConfiguration();

    expect(configuration.iceServers).toEqual([
      { urls: sharedUrl, username: "metered-user", credential: "metered-password" },
      { urls: sharedUrl, username: "cloudflare-user", credential: "cloudflare-password" },
      { urls: FALLBACK_STUN_URL },
    ]);
  });

  it("does not exceed the total URL bound when adding fallback STUN", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          provider: "metered+cloudflare",
          iceServers: Array.from({ length: 3 }, (_, serverIndex) => ({
            urls: Array.from(
              { length: 8 },
              (_, urlIndex) => `turn:relay-${serverIndex}-${urlIndex}.example:3478`,
            ),
            username: "user",
            credential: "credential",
          })),
        }),
      }),
    );

    const configuration = await rtcConfiguration();
    const configuredUrls = configuration.iceServers?.flatMap((server) => iceServerUrls(server));

    expect(configuredUrls).toHaveLength(24);
    expect(configuredUrls).not.toContain(FALLBACK_STUN_URL);
  });

  it("waits nine seconds before aborting the TURN credentials request", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { ...window, setTimeout, clearTimeout });
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
      });
    }));

    const configurationPromise = rtcConfiguration();
    await vi.advanceTimersByTimeAsync(8_999);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(requestSignal?.aborted).toBe(true);
    await expect(configurationPromise).resolves.toEqual({
      bundlePolicy: "max-bundle",
      iceServers: [{ urls: FALLBACK_STUN_URL }],
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

function iceServerUrls(server: RTCIceServer): string[] {
  return typeof server.urls === "string" ? [server.urls] : server.urls;
}
