import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("diagnostic privacy", () => {
  it("redacts URLs, IPv4, IPv6 and long secrets from error text", async () => {
    const { safeErrorText } = await import("./diagnostics");
    const secret = "abcdefghijklmnopqrstuvwxyz0123456789";

    expect(safeErrorText(`Failed at https://example.test/invite/${secret} from 203.0.113.9 and 2001:db8::1`)).toBe(
      "Failed at [url] from [ip] and [ip]",
    );
  });

  it("removes sensitive detail fields before storing an entry", async () => {
    vi.resetModules();
    const diagnostics = await import("./diagnostics");
    diagnostics.clearDiagnostics();

    diagnostics.logDiagnostic("connection", "test", {
      roomId: "private-room",
      candidate: "candidate:1 1 udp 1 203.0.113.9 1234 typ host",
      reason: "peer 203.0.113.9 failed",
      stage: "ice-check",
    });

    expect(diagnostics.getDiagnosticEntries()).toEqual([
      expect.objectContaining({
        details: { reason: "peer [ip] failed", stage: "ice-check" },
      }),
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
    vi.stubGlobal("navigator", { userAgent: "Test Browser", language: "en", onLine: true });
    const diagnostics = await import("./diagnostics");

    const report = diagnostics.formatDiagnosticReport();

    expect(report).toContain("origin=https://[ip]:8443");
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
});
