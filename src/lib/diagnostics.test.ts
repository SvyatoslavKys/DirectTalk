import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("diagnostic privacy", () => {
  it("redacts URLs, IPv4, IPv6 and long secrets from error text", async () => {
    const { safeErrorText } = await import("./diagnostics");
    const secret = "abcdefghijklmnopqrstuvwxyz0123456789";

    expect(safeErrorText(`Failed at https://example.test/invite/${secret} from 203.0.113.9 and 2001:db8::1 id 123e4567-e89b-42d3-a456-426614174000`)).toBe(
      "Failed at [url] from [ip] and [ip] id [id]",
    );
    expect(safeErrorText("WebSocket wss://example.test/api/signal TURN turns:secret.example:443")).toBe(
      "WebSocket [url] TURN [url]",
    );
  });

  it("redacts dotted IP-like values in generic error text", async () => {
    const { safeErrorText } = await import("./diagnostics");
    const userAgent = "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36 from 203.0.113.9";

    expect(safeErrorText(userAgent, 260)).toBe(
      "Mozilla/5.0 Chrome/[ip] Safari/537.36 from [ip]",
    );
  });

  it("does not mistake an IP after a browser-like prefix for a safe error value", async () => {
    const { safeErrorText } = await import("./diagnostics");

    expect(safeErrorText("failure Chrome/203.0.113.9:49152")).toBe("failure Chrome/[ip]");
    expect(safeErrorText("failure [2001:db8::1]:49152")).toBe("failure [ip]");
  });

  it("removes sensitive detail fields before storing an entry", async () => {
    vi.resetModules();
    const diagnostics = await import("./diagnostics");
    diagnostics.clearDiagnostics();

    diagnostics.logDiagnostic("connection", "test", {
      roomId: "private-room",
      candidate: "candidate:1 1 udp 1 203.0.113.9 1234 typ host",
      arbitrary: "must not be stored",
      reason: "peer 203.0.113.9 failed",
      stage: "ice-check",
    });

    expect(diagnostics.getDiagnosticEntries()).toEqual([
      expect.objectContaining({
        details: { reason: "peer [ip] failed", stage: "ice-check" },
      }),
    ]);
  });

  it("keeps privacy-safe app and transport counters", async () => {
    vi.resetModules();
    const diagnostics = await import("./diagnostics");
    diagnostics.clearDiagnostics();

    diagnostics.logDiagnostic("connection", "snapshot", {
      secureContext: true,
      messages: 2,
      queuedCandidates: 3,
      localRouteType: "srflx",
      remoteRouteType: "relay",
      packetsSent: 4,
      packetsReceived: 5,
      bufferedAmountBucket: "0",
      urlScheme: "turns",
      transport: "tls",
      iceErrorCount: 4,
      iceError701Count: 3,
      iceErrorRoutes: "stun/unknown:1,turn/udp:2,turns/tls:1",
    });

    expect(diagnostics.getDiagnosticEntries()).toEqual([
      expect.objectContaining({
        details: {
          secureContext: true,
          messages: 2,
          queuedCandidates: 3,
          localRouteType: "srflx",
          remoteRouteType: "relay",
          packetsSent: 4,
          packetsReceived: 5,
          bufferedAmountBucket: "0",
          urlScheme: "turns",
          transport: "tls",
          iceErrorCount: 4,
          iceError701Count: 3,
          iceErrorRoutes: "stun/unknown:1,turn/udp:2,turns/tls:1",
        },
      }),
    ]);
  });

  it("drops exact message and transport sizes even when a caller supplies legacy keys", async () => {
    vi.resetModules();
    const diagnostics = await import("./diagnostics");
    diagnostics.clearDiagnostics();

    diagnostics.logDiagnostic("connection", "snapshot", {
      bytes: 137,
      wireBytes: 211,
      bufferedAmount: 34,
      bufferedBefore: 12,
      bufferedAfter: 34,
      bytesSent: 1_234,
      bytesReceived: 5_678,
      wireSizeBucket: "1-255B",
    });

    expect(diagnostics.getDiagnosticEntries()).toEqual([
      expect.objectContaining({ details: { wireSizeBucket: "1-255B" } }),
    ]);
  });

  it("clears every stored event", async () => {
    vi.resetModules();
    const diagnostics = await import("./diagnostics");
    diagnostics.logDiagnostic("test", "before-clear");

    diagnostics.clearDiagnostics();

    expect(diagnostics.getDiagnosticEntries()).toHaveLength(0);
  });

  it("does not expose an IP-literal application origin in a report", async () => {
    vi.resetModules();
    vi.stubGlobal("window", {
      location: { protocol: "https:", hostname: "203.0.113.9", port: "8443", pathname: "/" },
      screen: { width: 1280, height: 720 },
      innerWidth: 1280,
      innerHeight: 720,
      isSecureContext: true,
    });
    vi.stubGlobal("document", { visibilityState: "visible" });
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36",
      language: "en",
      onLine: true,
    });
    const diagnostics = await import("./diagnostics");

    const report = diagnostics.formatDiagnosticReport();

    expect(report).toContain("origin=https://[ip]");
    expect(report).toContain("browser=Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36");
    expect(report).not.toContain("203.0.113.9");
  });

  it("records app start only once across a Strict Mode remount", async () => {
    vi.resetModules();
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal("window", {
      isSecureContext: true,
      addEventListener,
      removeEventListener,
    });
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener,
      removeEventListener,
    });
    vi.stubGlobal("navigator", { onLine: true });
    const diagnostics = await import("./diagnostics");
    diagnostics.clearDiagnostics();

    const firstCleanup = diagnostics.initializeDiagnostics();
    firstCleanup();
    const secondCleanup = diagnostics.initializeDiagnostics();
    secondCleanup();

    expect(diagnostics.getDiagnosticEntries().filter((entry) => entry.event === "started")).toHaveLength(1);
  });

  it("records Network Information changes and removes its listener on cleanup", async () => {
    vi.resetModules();
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const addConnectionListener = vi.fn();
    const removeConnectionListener = vi.fn();
    const connection = {
      effectiveType: "4g",
      downlink: 12.5,
      saveData: false,
      addEventListener: addConnectionListener,
      removeEventListener: removeConnectionListener,
    };
    vi.stubGlobal("window", {
      isSecureContext: true,
      addEventListener,
      removeEventListener,
    });
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener,
      removeEventListener,
    });
    vi.stubGlobal("navigator", { onLine: true, connection });
    const diagnostics = await import("./diagnostics");
    diagnostics.clearDiagnostics();

    const cleanup = diagnostics.initializeDiagnostics();
    connection.effectiveType = "3g";
    const changeListener = addConnectionListener.mock.calls[0]?.[1] as (() => void) | undefined;
    changeListener?.();
    cleanup();

    expect(diagnostics.getDiagnosticEntries()).toContainEqual(expect.objectContaining({
      scope: "network",
      event: "connection-change",
      details: { effectiveType: "3g", downlink: 12.5, saveData: false },
    }));
    expect(removeConnectionListener).toHaveBeenCalledWith("change", changeListener);
  });
});
