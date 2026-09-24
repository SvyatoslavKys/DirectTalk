import { afterEach, describe, expect, it, vi } from "vitest";
import { base64UrlEncode, randomBytes } from "./encoding";
import { DirectTalkConnection, parseAppPayload, summarizeTransportStats } from "./connection";
import { clearDiagnostics, getDiagnosticEntries } from "./diagnostics";
import { MAX_PHOTO_BYTES, photoChunkCount } from "./photos";
import { createIdentityKeys } from "./protocol";

const id = "123e4567-e89b-42d3-a456-426614174000";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearDiagnostics();
});

async function createTestConnection(role: "creator" | "joiner" = "creator") {
  return new DirectTalkConnection({
    roomId: base64UrlEncode(randomBytes(16)),
    inviteSecret: randomBytes(32),
    role,
    identity: await createIdentityKeys(),
    displayName: "Alice",
    onState: vi.fn(),
    onSecure: vi.fn(),
    onPayload: vi.fn(),
    onError: vi.fn(),
  });
}

function sentSignal(send: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return JSON.parse(send.mock.calls[0]?.[0] as string) as Record<string, unknown>;
}

describe("connection handshake", () => {
  it("sends only one hello when concurrent handshake paths race", async () => {
    const send = vi.fn();
    const connection = await createTestConnection();
    Object.assign(connection, { dataChannel: { readyState: "open", send } });
    const internal = connection as unknown as { sendHello: () => Promise<void> };

    await Promise.all([internal.sendHello(), internal.sendHello()]);

    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("ICE recovery", () => {
  it("refreshes TURN configuration and starts one initial ICE retry after the grace period", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      location: { hostname: "chat.example", protocol: "https:", host: "chat.example" },
      setTimeout,
      clearTimeout,
    });
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        provider: "metered",
        iceServers: [{
          urls: "turns:relay.example:443?transport=tcp",
          username: "fresh-user",
          credential: "fresh-credential",
        }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const connection = await createTestConnection("creator");
    const offer = { type: "offer", sdp: "v=0\r\na=ice-ufrag:retry-fragment\r\n" } satisfies RTCSessionDescriptionInit;
    const peerConnection = {
      connectionState: "failed",
      iceConnectionState: "failed",
      signalingState: "stable",
      iceGatheringState: "gathering",
      localDescription: null as RTCSessionDescriptionInit | null,
      getStats: vi.fn().mockResolvedValue(new Map()),
      setConfiguration: vi.fn(),
      createOffer: vi.fn().mockResolvedValue(offer),
      setLocalDescription: vi.fn().mockImplementation(async (description: RTCSessionDescriptionInit) => {
        peerConnection.localDescription = description;
      }),
    };
    const channel = { readyState: "connecting", close: vi.fn() };
    const socket = { readyState: 1, send: vi.fn(), close: vi.fn() };
    Object.assign(connection, { peerConnection, dataChannel: channel, socket, signalingPeerReady: true });
    const internal = connection as unknown as {
      handlePeerConnectionStateChange: (peer: RTCPeerConnection) => void;
    };

    internal.handlePeerConnectionStateChange(peerConnection as unknown as RTCPeerConnection);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(peerConnection.setConfiguration).toHaveBeenCalledWith(expect.objectContaining({
      iceServers: expect.arrayContaining([expect.objectContaining({ urls: "turns:relay.example:443?transport=tcp" })]),
    }));
    expect(peerConnection.createOffer).toHaveBeenCalledWith({ iceRestart: true });
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(socket.close).not.toHaveBeenCalled();
    expect(channel.close).not.toHaveBeenCalled();
    expect((connection as unknown as { initialIceAttempt: number }).initialIceAttempt).toBe(2);
  });

  it("cancels an initial disconnect retry when the route reconnects during grace", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    const connection = await createTestConnection();
    const startInitialIceRetry = vi.fn();
    const peerConnection = {
      connectionState: "disconnected",
      signalingState: "stable",
      getStats: vi.fn().mockResolvedValue(new Map()),
    };
    Object.assign(connection, { peerConnection, startInitialIceRetry });
    const internal = connection as unknown as {
      handlePeerConnectionStateChange: (peer: RTCPeerConnection) => void;
    };

    internal.handlePeerConnectionStateChange(peerConnection as unknown as RTCPeerConnection);
    peerConnection.connectionState = "connected";
    internal.handlePeerConnectionStateChange(peerConnection as unknown as RTCPeerConnection);
    await vi.advanceTimersByTimeAsync(1_500);

    expect(startInitialIceRetry).not.toHaveBeenCalled();
  });

  it("exhausts initial ICE retries after two restart attempts and records the candidate summary", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const connection = await createTestConnection();
    const peerConnection = {
      connectionState: "failed",
      getStats: vi.fn().mockResolvedValue(new Map()),
      close: vi.fn(),
    };
    const channel = { readyState: "connecting", close: vi.fn() };
    const socket = { close: vi.fn() };
    Object.assign(connection, {
      peerConnection,
      dataChannel: channel,
      socket,
      initialIceAttempt: 3,
      relayConfigured: true,
      localCandidateCount: 2,
      localCandidateTypes: { host: 1, srflx: 1, prflx: 0, relay: 0, unknown: 0 },
    });
    const internal = connection as unknown as {
      handlePeerConnectionStateChange: (peer: RTCPeerConnection) => void;
    };

    internal.handlePeerConnectionStateChange(peerConnection as unknown as RTCPeerConnection);
    await vi.advanceTimersByTimeAsync(1_500);

    expect((connection as unknown as { closed: boolean }).closed).toBe(true);
    const entries = getDiagnosticEntries();
    expect(entries.map((entry) => entry.event)).toEqual(expect.arrayContaining([
      "initial-ice-candidate-summary",
      "initial-ice-retry-failed",
      "initial-ice-retry-exhausted",
    ]));
    expect(entries.find((entry) => entry.event === "initial-ice-candidate-summary")?.details).toMatchObject({
      attempt: 3,
      hostCandidates: 1,
      srflxCandidates: 1,
      relayCandidates: 0,
      relayConfigured: true,
    });
  });

  it("uses an attempt watchdog when a retry remains stuck without another state event", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const connection = await createTestConnection();
    const startInitialIceRetry = vi.fn().mockResolvedValue(true);
    const peerConnection = { connectionState: "connecting" };
    Object.assign(connection, { peerConnection, startInitialIceRetry, initialIceRetryActive: true });
    const internal = connection as unknown as {
      armInitialIceAttemptTimer: (peer: RTCPeerConnection, generation: number) => void;
    };

    internal.armInitialIceAttemptTimer(peerConnection as unknown as RTCPeerConnection, 0);
    await vi.advanceTimersByTimeAsync(18_000 + 1_499);
    expect(startInitialIceRetry).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(startInitialIceRetry).toHaveBeenCalledWith("timeout", peerConnection);
  });

  it("invalidates a delayed credential refresh when the original route reconnects", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      location: { hostname: "chat.example", protocol: "https:", host: "chat.example" },
      setTimeout,
      clearTimeout,
    });
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    let resolveFetch!: (response: unknown) => void;
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise((resolve) => {
      resolveFetch = resolve;
    })));
    const connection = await createTestConnection("creator");
    const peerConnection = {
      connectionState: "failed",
      signalingState: "stable",
      getStats: vi.fn().mockResolvedValue(new Map()),
      setConfiguration: vi.fn(),
      createOffer: vi.fn(),
      close: vi.fn(),
    };
    Object.assign(connection, { peerConnection, dataChannel: { readyState: "connecting", close: vi.fn() } });
    const internal = connection as unknown as {
      startInitialIceRetry: (trigger: string, peer: RTCPeerConnection) => Promise<boolean>;
      handlePeerConnectionStateChange: (peer: RTCPeerConnection) => void;
      resetPeerConnection: () => void;
    };

    const retry = internal.startInitialIceRetry("failed", peerConnection as unknown as RTCPeerConnection);
    await Promise.resolve();
    peerConnection.connectionState = "connected";
    internal.handlePeerConnectionStateChange(peerConnection as unknown as RTCPeerConnection);
    resolveFetch({
      ok: true,
      status: 200,
      json: async () => ({
        provider: "metered",
        iceServers: [{ urls: "turns:relay.example:443", username: "user", credential: "credential" }],
      }),
    });
    await retry;

    expect(peerConnection.setConfiguration).not.toHaveBeenCalled();
    expect(peerConnection.createOffer).not.toHaveBeenCalled();
    internal.resetPeerConnection();
    expect((connection as unknown as { initialIceAttempt: number }).initialIceAttempt).toBe(1);
  });

  it("waits for a passive joiner refresh before applying a restart offer", async () => {
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    const connection = await createTestConnection("joiner");
    let finishPreparation!: (prepared: boolean) => void;
    const preparation = new Promise<boolean>((resolve) => {
      finishPreparation = resolve;
    });
    const answer = { type: "answer", sdp: "v=0\r\na=ice-ufrag:new-local\r\n" } satisfies RTCSessionDescriptionInit;
    const peerConnection = {
      connectionState: "failed",
      signalingState: "stable",
      remoteDescription: { type: "offer", sdp: "old" },
      localDescription: null as RTCSessionDescriptionInit | null,
      setRemoteDescription: vi.fn().mockResolvedValue(undefined),
      createAnswer: vi.fn().mockResolvedValue(answer),
      setLocalDescription: vi.fn().mockImplementation(async (description: RTCSessionDescriptionInit) => {
        peerConnection.localDescription = description;
      }),
      addIceCandidate: vi.fn(),
    };
    const socket = { readyState: 1, send: vi.fn() };
    Object.assign(connection, {
      peerConnection,
      socket,
      iceGeneration: "AbCdEfGhIjKlMn01",
      initialIceRetryActive: true,
      initialIcePreparation: preparation,
    });
    const internal = connection as unknown as {
      handleRemoteDescription: (description: RTCSessionDescriptionInit, iceGeneration: string) => Promise<void>;
    };

    const applying = internal.handleRemoteDescription(
      { type: "offer", sdp: "v=0\r\na=ice-ufrag:remote-new\r\n" },
      "ZyXwVuTsRqPoNm10",
    );
    await Promise.resolve();
    expect(peerConnection.setRemoteDescription).not.toHaveBeenCalled();
    finishPreparation(true);
    await applying;

    expect(peerConnection.setRemoteDescription).toHaveBeenCalledTimes(1);
    expect(peerConnection.createAnswer).toHaveBeenCalledTimes(1);
    expect(socket.send).toHaveBeenCalledTimes(1);
  });

  it("still signals an answer when the restarted route connects during setLocalDescription", async () => {
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    const connection = await createTestConnection("joiner");
    const answer = { type: "answer", sdp: "v=0\r\na=ice-ufrag:new-local\r\n" } satisfies RTCSessionDescriptionInit;
    let internal!: {
      handleRemoteDescription: (description: RTCSessionDescriptionInit, iceGeneration: string) => Promise<void>;
      handlePeerConnectionStateChange: (peer: RTCPeerConnection) => void;
    };
    const peerConnection = {
      connectionState: "failed",
      signalingState: "stable",
      remoteDescription: { type: "offer", sdp: "old" },
      localDescription: null as RTCSessionDescriptionInit | null,
      getStats: vi.fn().mockResolvedValue(new Map()),
      setRemoteDescription: vi.fn().mockResolvedValue(undefined),
      createAnswer: vi.fn().mockResolvedValue(answer),
      setLocalDescription: vi.fn().mockImplementation(async (description: RTCSessionDescriptionInit) => {
        peerConnection.localDescription = description;
        peerConnection.connectionState = "connected";
        internal.handlePeerConnectionStateChange(peerConnection as unknown as RTCPeerConnection);
      }),
      addIceCandidate: vi.fn(),
    };
    const socket = { readyState: 1, send: vi.fn() };
    Object.assign(connection, {
      peerConnection,
      socket,
      iceGeneration: "AbCdEfGhIjKlMn01",
      initialIceAttempt: 2,
      initialIceRetryActive: true,
    });
    internal = connection as unknown as typeof internal;

    await internal.handleRemoteDescription(
      { type: "offer", sdp: "v=0\r\na=ice-ufrag:remote-new\r\n" },
      "ZyXwVuTsRqPoNm10",
    );

    expect(peerConnection.setLocalDescription).toHaveBeenCalledWith(answer);
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(sentSignal(socket.send)).toMatchObject({
      type: "signal",
      payload: { description: answer, iceGeneration: "ZyXwVuTsRqPoNm10" },
    });
  });

  it("creates an ICE-restart offer without replacing the peer connection", async () => {
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    const connection = await createTestConnection("creator");
    const offer = { type: "offer", sdp: "v=0\r\na=ice-ufrag:current-fragment\r\n" } satisfies RTCSessionDescriptionInit;
    const peerConnection = {
      createOffer: vi.fn().mockResolvedValue(offer),
      setLocalDescription: vi.fn().mockResolvedValue(undefined),
    };
    const socket = { readyState: 1, send: vi.fn() };
    Object.assign(connection, {
      recovering: true,
      recoveryAttempts: 1,
      signalingPeerReady: true,
      peerConnection,
      socket,
    });
    const internal = connection as unknown as { createRecoveryOffer: () => Promise<void> };

    await internal.createRecoveryOffer();

    expect(peerConnection.createOffer).toHaveBeenCalledWith({ iceRestart: true });
    expect(peerConnection.setLocalDescription).toHaveBeenCalledWith(offer);
    expect(sentSignal(socket.send)).toMatchObject({ type: "signal", payload: { description: offer } });
    expect((sentSignal(socket.send).payload as Record<string, unknown>).iceGeneration).toMatch(/^[A-Za-z0-9_-]{16}$/u);
    expect([...(connection as unknown as { localIceUsernameFragments: Set<string> }).localIceUsernameFragments])
      .toEqual(["current-fragment"]);
  });

  it("does not apply a delayed offer from an obsolete recovery generation", async () => {
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    const connection = await createTestConnection("creator");
    const offer = { type: "offer", sdp: "obsolete-sdp" } satisfies RTCSessionDescriptionInit;
    let resolveOffer!: (value: RTCSessionDescriptionInit) => void;
    const deferredOffer = new Promise<RTCSessionDescriptionInit>((resolve) => {
      resolveOffer = resolve;
    });
    const peerConnection = {
      createOffer: vi.fn().mockReturnValue(deferredOffer),
      setLocalDescription: vi.fn(),
    };
    const firstSocket = { readyState: 1, send: vi.fn() };
    Object.assign(connection, {
      recovering: true,
      recoveryAttempts: 1,
      recoveryGeneration: 1,
      signalingPeerReady: true,
      peerConnection,
      socket: firstSocket,
    });
    const internal = connection as unknown as { createRecoveryOffer: () => Promise<void> };

    const operation = internal.createRecoveryOffer();
    Object.assign(connection, {
      recoveryGeneration: 2,
      recoveryOfferStarted: false,
      socket: { readyState: 1, send: vi.fn() },
    });
    resolveOffer(offer);
    await operation;

    expect(peerConnection.setLocalDescription).not.toHaveBeenCalled();
    expect(firstSocket.send).not.toHaveBeenCalled();
  });

  it("waits through a short disconnect before starting recovery", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const connection = await createTestConnection();
    const startIceRecovery = vi.fn();
    const peerConnection = {
      connectionState: "disconnected",
      getStats: vi.fn().mockResolvedValue(new Map()),
    };
    Object.assign(connection, { secureNotified: true, peerConnection, startIceRecovery });
    const internal = connection as unknown as {
      handlePeerConnectionStateChange: (peer: RTCPeerConnection) => void;
    };

    internal.handlePeerConnectionStateChange(peerConnection as unknown as RTCPeerConnection);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(startIceRecovery).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(startIceRecovery).toHaveBeenCalledWith("disconnected");
  });

  it("cancels recovery when a short disconnect reconnects inside the grace period", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    const connection = await createTestConnection();
    const startIceRecovery = vi.fn();
    const peerConnection = {
      connectionState: "disconnected",
      signalingState: "stable",
      getStats: vi.fn().mockResolvedValue(new Map()),
    };
    Object.assign(connection, { secureNotified: true, peerConnection, startIceRecovery });
    const internal = connection as unknown as {
      handlePeerConnectionStateChange: (peer: RTCPeerConnection) => void;
    };

    internal.handlePeerConnectionStateChange(peerConnection as unknown as RTCPeerConnection);
    peerConnection.connectionState = "connected";
    internal.handlePeerConnectionStateChange(peerConnection as unknown as RTCPeerConnection);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(startIceRecovery).not.toHaveBeenCalled();
  });

  it("treats a post-secure peer-ready event as a restart request", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    const connection = await createTestConnection("creator");
    const offer = { type: "offer", sdp: "restart-sdp" } satisfies RTCSessionDescriptionInit;
    const peerConnection = {
      connectionState: "connected",
      iceConnectionState: "connected",
      signalingState: "stable",
      createOffer: vi.fn().mockResolvedValue(offer),
      setLocalDescription: vi.fn().mockImplementation(async () => {
        peerConnection.signalingState = "have-local-offer";
      }),
    };
    const socket = { readyState: 1, send: vi.fn() };
    Object.assign(connection, {
      secureNotified: true,
      session: {},
      dataChannel: { readyState: "open" },
      peerConnection,
      socket,
      offerStarted: true,
    });
    const internal = connection as unknown as { handleSignalMessage: (raw: string) => Promise<void> };

    await internal.handleSignalMessage(JSON.stringify({ type: "peer-ready" }));

    expect(peerConnection.createOffer).toHaveBeenCalledWith({ iceRestart: true });
    expect(sentSignal(socket.send)).toMatchObject({ type: "signal", payload: { description: offer } });
    expect((sentSignal(socket.send).payload as Record<string, unknown>).iceGeneration).toMatch(/^[A-Za-z0-9_-]{16}$/u);
  });

  it("answers a post-secure restart offer even before its own disconnect event", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    const connection = await createTestConnection("joiner");
    const answer = { type: "answer", sdp: "restart-answer" } satisfies RTCSessionDescriptionInit;
    const peerConnection = {
      connectionState: "connected",
      iceConnectionState: "connected",
      signalingState: "stable",
      remoteDescription: { type: "answer", sdp: "old-answer" },
      setRemoteDescription: vi.fn().mockImplementation(async () => {
        peerConnection.signalingState = "have-remote-offer";
        peerConnection.iceConnectionState = "checking";
        Object.assign(connection, { recoverySawChecking: true });
      }),
      createAnswer: vi.fn().mockResolvedValue(answer),
      setLocalDescription: vi.fn().mockImplementation(async () => {
        peerConnection.signalingState = "stable";
        peerConnection.iceConnectionState = "connected";
      }),
      addIceCandidate: vi.fn(),
    };
    const socket = { readyState: 1, send: vi.fn() };
    const oldCloseTimer = window.setTimeout(vi.fn(), 30_000);
    Object.assign(connection, {
      secureNotified: true,
      session: {},
      dataChannel: { readyState: "open" },
      peerConnection,
      socket,
      signalingCloseTimer: oldCloseTimer,
    });
    const internal = connection as unknown as {
      handleRemoteDescription: (description: RTCSessionDescriptionInit, iceGeneration?: string) => Promise<void>;
    };
    const iceGeneration = "AbCdEfGhIjKlMn01";

    await internal.handleRemoteDescription({ type: "offer", sdp: "restart-offer" }, iceGeneration);

    expect(peerConnection.createAnswer).toHaveBeenCalledTimes(1);
    expect(sentSignal(socket.send)).toEqual({
      type: "signal",
      payload: { description: answer, iceGeneration },
    });
    expect((connection as unknown as { recovering: boolean }).recovering).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rolls back an unfinished offer before scheduling another recovery attempt", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const connection = await createTestConnection("creator");
    const startIceRecovery = vi.fn();
    const peerConnection = {
      connectionState: "failed",
      iceConnectionState: "failed",
      signalingState: "have-local-offer",
      setLocalDescription: vi.fn().mockImplementation(async (description: RTCSessionDescriptionInit) => {
        if (description.type === "rollback") peerConnection.signalingState = "stable";
      }),
    };
    Object.assign(connection, {
      recovering: true,
      recoveryAttempts: 1,
      recoveryGeneration: 1,
      recoveryOfferStarted: true,
      peerConnection,
      startIceRecovery,
    });
    const internal = connection as unknown as { handleRecoveryAttemptFailure: (trigger: string) => void };

    internal.handleRecoveryAttemptFailure("timeout");
    await Promise.resolve();

    expect(peerConnection.setLocalDescription).toHaveBeenCalledWith({ type: "rollback" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(startIceRecovery).toHaveBeenCalledWith("retry");
  });

  it("keeps signaling open until ICE gathering is complete plus a grace period", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    const connection = await createTestConnection();
    const socket = { readyState: 1, close: vi.fn() };
    const peerConnection = { iceGatheringState: "complete", connectionState: "connected" };
    Object.assign(connection, {
      secureNotified: true,
      socket,
      peerConnection,
      localIceComplete: true,
      remoteIceComplete: false,
    });
    const internal = connection as unknown as { maybeScheduleSignalingClose: () => void };

    internal.maybeScheduleSignalingClose();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(socket.close).not.toHaveBeenCalled();
    Object.assign(connection, { remoteIceComplete: true });
    internal.maybeScheduleSignalingClose();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(socket.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.close).toHaveBeenCalledWith(1000, "Signaling complete");
  });

  it("records the remote end-of-candidates marker without treating it as an address", async () => {
    const connection = await createTestConnection("joiner");
    const peerConnection = {
      remoteDescription: { type: "offer", sdp: "safe-test-sdp" },
      addIceCandidate: vi.fn().mockResolvedValue(undefined),
    };
    const iceGeneration = "AbCdEfGhIjKlMn01";
    Object.assign(connection, { peerConnection, iceGeneration });
    const internal = connection as unknown as {
      handleRemoteCandidate: (candidate: RTCIceCandidateInit, iceGeneration?: string) => Promise<void>;
    };

    await internal.handleRemoteCandidate({ candidate: "", usernameFragment: "safe-ufrag" }, iceGeneration);

    expect(peerConnection.addIceCandidate).toHaveBeenCalledWith({ candidate: "", usernameFragment: "safe-ufrag" });
    expect((connection as unknown as { remoteIceComplete: boolean }).remoteIceComplete).toBe(true);
  });

  it("ignores candidates and end markers from an obsolete ICE generation", async () => {
    const connection = await createTestConnection("joiner");
    const peerConnection = {
      remoteDescription: { type: "offer", sdp: "new-sdp" },
      addIceCandidate: vi.fn(),
    };
    Object.assign(connection, { peerConnection, iceGeneration: "AbCdEfGhIjKlMn01" });
    const internal = connection as unknown as {
      handleRemoteCandidate: (candidate: RTCIceCandidateInit, iceGeneration?: string) => Promise<void>;
    };

    await internal.handleRemoteCandidate(
      { candidate: "candidate:1 1 udp 1 192.0.2.1 5000 typ host" },
      "ZyXwVuTsRqPoNm10",
    );
    await internal.handleRemoteCandidate({ candidate: "" }, "ZyXwVuTsRqPoNm10");

    expect(peerConnection.addIceCandidate).not.toHaveBeenCalled();
    expect((connection as unknown as { remoteIceComplete: boolean }).remoteIceComplete).toBe(false);
  });

  it("does not relabel a late local candidate from an obsolete ICE username fragment", async () => {
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    const connection = await createTestConnection("creator");
    const socket = { readyState: 1, send: vi.fn() };
    const peerConnection = { iceGatheringState: "gathering" };
    const candidate = {
      candidate: "candidate:1 1 udp 1 192.0.2.1 5000 typ host ufrag old-fragment",
      usernameFragment: "old-fragment",
      type: "host",
      toJSON: vi.fn().mockReturnValue({
        candidate: "candidate:1 1 udp 1 192.0.2.1 5000 typ host ufrag old-fragment",
        usernameFragment: "old-fragment",
      }),
    };
    Object.assign(connection, {
      socket,
      peerConnection,
      iceGeneration: "AbCdEfGhIjKlMn01",
      localIceDescriptionReady: true,
      localIceUsernameFragments: new Set(["new-fragment"]),
    });
    const internal = connection as unknown as {
      handleLocalIceCandidate: (candidate: RTCIceCandidate | null, peer: RTCPeerConnection) => void;
    };

    internal.handleLocalIceCandidate(
      candidate as unknown as RTCIceCandidate,
      peerConnection as unknown as RTCPeerConnection,
    );

    expect(socket.send).not.toHaveBeenCalled();
    expect(candidate.toJSON).not.toHaveBeenCalled();
  });

  it("sends the local description before candidates gathered during setLocalDescription", async () => {
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    const connection = await createTestConnection("creator");
    const socket = { readyState: 1, send: vi.fn() };
    const peerConnection = { iceGatheringState: "gathering" };
    const candidateInit = {
      candidate: "candidate:1 1 udp 1 192.0.2.1 5000 typ host ufrag current-fragment",
      usernameFragment: "current-fragment",
    };
    const candidate = {
      ...candidateInit,
      type: "host",
      toJSON: vi.fn().mockReturnValue(candidateInit),
    };
    Object.assign(connection, {
      socket,
      peerConnection,
      iceGeneration: "AbCdEfGhIjKlMn01",
      localIceDescriptionReady: true,
      localIceUsernameFragments: new Set(["current-fragment"]),
      localDescriptionSignaled: false,
    });
    const internal = connection as unknown as {
      handleLocalIceCandidate: (candidate: RTCIceCandidate | null, peer: RTCPeerConnection) => void;
      signalLocalDescription: (description: RTCSessionDescriptionInit) => void;
    };

    internal.handleLocalIceCandidate(
      candidate as unknown as RTCIceCandidate,
      peerConnection as unknown as RTCPeerConnection,
    );
    expect(socket.send).not.toHaveBeenCalled();

    internal.signalLocalDescription({ type: "offer", sdp: "v=0" });

    expect(socket.send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(socket.send.mock.calls[0]?.[0] as string)).toMatchObject({
      type: "signal",
      payload: { description: { type: "offer" }, iceGeneration: "AbCdEfGhIjKlMn01" },
    });
    expect(JSON.parse(socket.send.mock.calls[1]?.[0] as string)).toMatchObject({
      type: "signal",
      payload: { candidate: candidateInit, iceGeneration: "AbCdEfGhIjKlMn01" },
    });
  });

  it("signals the current end-of-candidates marker once with its ICE username fragment", async () => {
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    const connection = await createTestConnection("creator");
    const socket = { readyState: 1, send: vi.fn() };
    const peerConnection = { iceGatheringState: "complete" };
    Object.assign(connection, {
      socket,
      peerConnection,
      iceGeneration: "AbCdEfGhIjKlMn01",
      localIceDescriptionReady: true,
      localIceUsernameFragments: new Set(["current-fragment"]),
      localDescriptionSignaled: true,
    });
    const internal = connection as unknown as {
      handleLocalIceCandidate: (candidate: RTCIceCandidate | null, peer: RTCPeerConnection) => void;
    };

    internal.handleLocalIceCandidate(null, peerConnection as unknown as RTCPeerConnection);
    internal.handleLocalIceCandidate(null, peerConnection as unknown as RTCPeerConnection);

    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(sentSignal(socket.send)).toEqual({
      type: "signal",
      payload: {
        candidate: { candidate: "", usernameFragment: "current-fragment" },
        iceGeneration: "AbCdEfGhIjKlMn01",
      },
    });
  });

  it("does not finish a negotiated restart until the new ICE route has been checked", async () => {
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    const connection = await createTestConnection("creator");
    const peerConnection = {
      connectionState: "connected",
      iceConnectionState: "connected",
      signalingState: "stable",
      getStats: vi.fn().mockResolvedValue(new Map()),
    };
    Object.assign(connection, {
      secureNotified: true,
      recovering: true,
      recoveryAttempts: 1,
      recoveryOfferStarted: true,
      recoveryNegotiated: true,
      recoverySawChecking: false,
      peerConnection,
    });
    const internal = connection as unknown as {
      handlePeerConnectionStateChange: (peer: RTCPeerConnection) => void;
    };

    internal.handlePeerConnectionStateChange(peerConnection as unknown as RTCPeerConnection);
    expect((connection as unknown as { recovering: boolean }).recovering).toBe(true);

    Object.assign(connection, { recoverySawChecking: true });
    internal.handlePeerConnectionStateChange(peerConnection as unknown as RTCPeerConnection);
    expect((connection as unknown as { recovering: boolean }).recovering).toBe(false);
  });
});

describe("transport diagnostics", () => {
  it("reports route health without exposing candidate IDs, addresses, ports or URLs", () => {
    const report = new Map<string, Record<string, unknown>>([
      ["transport-private-id", { id: "transport-private-id", type: "transport", selectedCandidatePairId: "pair-private-id" }],
      ["pair-private-id", {
        id: "pair-private-id",
        type: "candidate-pair",
        state: "succeeded",
        nominated: true,
        localCandidateId: "local-private-id",
        remoteCandidateId: "remote-private-id",
        bytesSent: 1234,
        bytesReceived: 5678,
        currentRoundTripTime: 0.042,
      }],
      ["local-private-id", {
        id: "local-private-id",
        type: "local-candidate",
        candidateType: "relay",
        protocol: "udp",
        relayProtocol: "tcp",
        address: "203.0.113.9",
        port: 49_152,
        url: "turn:secret.example:3478?transport=tcp",
      }],
      ["remote-private-id", {
        id: "remote-private-id",
        type: "remote-candidate",
        candidateType: "srflx",
        address: "2001:db8::1",
        port: 54_321,
      }],
    ]);

    const summary = summarizeTransportStats(
      report as unknown as RTCStatsReport,
      { readyState: "open", bufferedAmount: 32 },
    );
    const serialized = JSON.stringify(summary);

    expect(summary).toMatchObject({
      channelState: "open",
      bufferedAmountBucket: "1-255B",
      localRouteType: "relay",
      remoteRouteType: "srflx",
      protocol: "udp",
      relayProtocol: "tcp",
      pairState: "succeeded",
      nominated: true,
      bytesSentBucket: "1-16KiB",
      bytesReceivedBucket: "1-16KiB",
      currentRoundTripTimeMs: 42,
    });
    expect(serialized).not.toContain("private-id");
    expect(serialized).not.toContain("203.0.113.9");
    expect(serialized).not.toContain("2001:db8::1");
    expect(serialized).not.toContain("secret.example");
    expect(serialized).not.toContain("49152");
    expect(serialized).not.toContain("1234");
    expect(serialized).not.toContain("5678");
  });
});

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
