import { rtcConfiguration, signalingUrl } from "./config";
import { base64UrlEncode, randomBytes } from "./encoding";
import {
  createLocalHandshake,
  deriveSession,
  openHelloMessage,
  sealHelloMessage,
  verifyRemoteHello,
  type DerivedSession,
  type HelloMessage,
  type IdentityKeys,
  type LocalHandshake,
  type PeerRole,
} from "./protocol";
import {
  MAX_PHOTO_BYTES,
  MAX_PHOTO_CHUNKS,
  MAX_PHOTO_CHUNK_TEXT,
  isPhotoMimeType,
  isSafePhotoName,
  photoChunkCount,
  type PhotoMimeType,
} from "./photos";
import { logDiagnostic, safeErrorText } from "./diagnostics";

const SIGNALING_CLOSE_GRACE_MS = 2_000;
const DISCONNECTED_GRACE_MS = 1_500;
const INITIAL_ICE_FAILURE_GRACE_MS = 1_500;
const INITIAL_ICE_ATTEMPT_TIMEOUT_MS = 18_000;
const MAX_INITIAL_ICE_ATTEMPTS = 3;
const RECOVERY_TIMEOUT_MS = 15_000;
const RECOVERY_RETRY_DELAY_MS = 1_000;
const MAX_RECOVERY_ATTEMPTS = 2;

export type ConnectionState =
  | "connecting-signaling"
  | "waiting-peer"
  | "connecting-peer"
  | "reconnecting"
  | "waiting-reconnect"
  | "authenticating"
  | "secure"
  | "closed";

export type AppPayload =
  | { kind: "session-ready" }
  | { kind: "chat-message"; id: string; text: string; createdAt: number }
  | { kind: "ack"; messageId: string; status: "delivered" | "read" }
  | {
      kind: "photo-offer";
      id: string;
      name: string;
      mime: PhotoMimeType;
      size: number;
      sha256: string;
      chunks: number;
      createdAt: number;
    }
  | { kind: "photo-response"; id: string; accepted: boolean }
  | { kind: "photo-chunk"; id: string; index: number; data: string }
  | { kind: "photo-complete"; id: string }
  | { kind: "photo-received"; id: string }
  | { kind: "photo-cancel"; id: string; reason: PhotoCancelReason }
  | { kind: "delete-message"; messageId: string }
  | { kind: "delete-message-result"; messageId: string; deleted: boolean }
  | { kind: "clear-chat-request"; id: string }
  | { kind: "clear-chat-response"; id: string; accepted: boolean };

export type PhotoCancelReason = "cancelled" | "invalid" | "hash-mismatch" | "unsupported" | "transfer-failed";
export type PhotoOfferPayload = Extract<AppPayload, { kind: "photo-offer" }>;

export interface SecurePeer {
  id: string;
  name: string;
  identityKey: string;
  fingerprint: string;
  securityCode: string;
}

interface ConnectionOptions {
  roomId: string;
  inviteSecret: Uint8Array<ArrayBuffer>;
  role: PeerRole;
  identity: IdentityKeys;
  displayName: string;
  expectedCreatorIdentity?: string;
  expectedPeerIdentity?: string;
  resume?: boolean;
  onState: (state: ConnectionState) => void;
  onSecure: (peer: SecurePeer) => void;
  onPayload: (payload: Exclude<AppPayload, { kind: "session-ready" }>) => void | Promise<void>;
  onError: (message: string) => void;
}

export class DirectTalkConnection {
  private socket?: WebSocket;
  private peerConnection?: RTCPeerConnection;
  private dataChannel?: RTCDataChannel;
  private localHandshakePromise?: Promise<LocalHandshake>;
  private helloSendPromise?: Promise<void>;
  private remoteHello?: HelloMessage;
  private session?: DerivedSession;
  private sentHello = false;
  private sentSessionReady = false;
  private receivedSessionReady = false;
  private secureNotified = false;
  private offerStarted = false;
  private closed = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private incomingQueue: Promise<void> = Promise.resolve();
  private signalingQueue: Promise<void> = Promise.resolve();
  private outgoingQueue: Promise<void> = Promise.resolve();
  private activeNegotiation?: Promise<void>;
  private reconnectTimer?: number;
  private signalingCloseTimer?: number;
  private disconnectedTimer?: number;
  private initialIceFailureTimer?: number;
  private initialIceAttemptTimer?: number;
  private recoveryTimer?: number;
  private reconnectAttempts = 0;
  private recoveryAttempts = 0;
  private recovering = false;
  private recoveryOfferStarted = false;
  private recoveryNegotiated = false;
  private awaitingRecoveryRemoteDescription = false;
  private recoveryStartedAt = 0;
  private recoveryGeneration = 0;
  private recoverySawChecking = false;
  private initialIceAttempt = 1;
  private initialIceRetryActive = false;
  private initialIceRefreshPending = false;
  private initialIceRetryGeneration = 0;
  private initialIcePreparation?: Promise<boolean>;
  private signalingPeerReady = false;
  private signalingGeneration = 0;
  private peerGeneration = 0;
  private lastStage = "created";
  private localCandidateCount = 0;
  private remoteCandidateCount = 0;
  private localCandidateTypes = createCandidateCounters();
  private candidateSummaryLogged = false;
  private iceErrorCount = 0;
  private iceError701Count = 0;
  private iceErrorRoutes = new Map<string, number>();
  private localIceComplete = false;
  private remoteIceComplete = false;
  private iceGeneration?: string;
  private legacyIceGeneration = false;
  private localIceDescriptionReady = false;
  private localIceUsernameFragments = new Set<string>();
  private localDescriptionSignaled = false;
  private pendingLocalCandidates: RTCIceCandidateInit[] = [];
  private relayConfigured = false;
  private queryFreeTurnUrls = false;
  private txPackets = 0;
  private rxPackets = 0;
  private rtcConfig?: RTCConfiguration;
  private startPromise?: Promise<void>;
  private sessionReconnectActive: boolean;
  private pinnedPeerIdentity?: string;
  private hasEstablishedSession = false;

  constructor(private readonly options: ConnectionOptions) {
    this.sessionReconnectActive = Boolean(options.resume);
    this.pinnedPeerIdentity = options.expectedPeerIdentity;
  }

  connect(): void {
    if (this.socket || this.startPromise || this.closed || this.secureNotified) return;
    this.trace("connect", { role: this.options.role });
    this.options.onState(this.sessionReconnectActive ? "reconnecting" : "connecting-signaling");
    const operation = this.startConnection();
    this.startPromise = operation;
    void operation
      .catch((error: unknown) => this.fail(error, "rtc-configuration"))
      .finally(() => {
        if (this.startPromise === operation) this.startPromise = undefined;
      });
  }

  private async startConnection(): Promise<void> {
    const configuration = await rtcConfiguration();
    if (this.closed) return;
    this.applyRtcConfiguration(configuration);
    if (!this.peerConnection) this.setupPeerConnection();
    this.openSignalingSocket();
  }

  private applyRtcConfiguration(configuration: RTCConfiguration): void {
    this.rtcConfig = this.queryFreeTurnUrls
      ? queryFreeTurnConfiguration(configuration) ?? configuration
      : configuration;
    const serverCount = this.rtcConfig.iceServers?.length ?? 0;
    this.relayConfigured = this.rtcConfig.iceServers?.some((server) => {
      const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
      return urls.some((url) => /^(?:turn|turns):/iu.test(url));
    }) ?? false;
    this.trace("rtc-configuration-ready", { serverCount, relayConfigured: this.relayConfigured });
  }

  private openSignalingSocket(): void {
    if (this.socket || this.closed || (this.secureNotified && !this.recovering)) return;
    this.signalingPeerReady = false;
    this.trace("signaling-opening", this.recovering ? { attempt: this.recoveryAttempts } : undefined);
    let socket: WebSocket;
    try {
      socket = new WebSocket(signalingUrl());
    } catch (error) {
      if (this.recovering) this.handleRecoveryAttemptFailure("signaling-constructor");
      else this.fail(error, "signaling-constructor");
      return;
    }
    const signalingGeneration = ++this.signalingGeneration;
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket || this.closed) return;
      this.trace("signaling-open");
      if (!this.recovering && !this.sessionReconnectActive) this.reconnectAttempts = 0;
      socket.send(JSON.stringify({ type: "join", roomId: this.options.roomId, role: this.options.role }));
      this.trace("signaling-join-sent");
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || this.closed) return;
      this.signalingQueue = this.signalingQueue
        .then(async () => {
          if (this.socket !== socket || signalingGeneration !== this.signalingGeneration || this.closed) return;
          await this.handleSignalMessage(event.data);
        })
        .catch((error: unknown) => {
          if (this.socket !== socket || signalingGeneration !== this.signalingGeneration || this.closed) return;
          if (this.recovering) this.handleRecoveryAttemptFailure("signaling-message");
          else this.fail(error, "signaling-message");
        });
    });
    socket.addEventListener("error", () => {
      // The close event schedules a reconnect. Browsers intentionally expose no
      // useful details for WebSocket connection errors.
      this.trace("signaling-error", undefined, "warn");
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.signalingGeneration += 1;
      this.signalingPeerReady = false;
      this.trace("signaling-closed", { code: event.code, clean: event.wasClean }, event.wasClean ? "info" : "warn");
      if (this.closed) return;
      if (this.recovering) this.handleRecoveryAttemptFailure("signaling-closed");
      else if (!this.secureNotified) this.scheduleSignalingReconnect(event.reason);
    });
  }

  async send(payload: Exclude<AppPayload, { kind: "session-ready" }>): Promise<void> {
    const operation = this.outgoingQueue.then(async () => {
      if (!this.session || !this.secureNotified || this.dataChannel?.readyState !== "open" || this.closed) {
        this.trace("send-rejected", {
          kind: payload.kind,
          secure: this.secureNotified,
          channelState: this.dataChannel?.readyState ?? "missing",
          closed: this.closed,
        }, "warn");
        throw new Error("Защищённое соединение ещё не готово");
      }
      const channel = this.dataChannel;
      const wire = await this.session.cipher.seal(payload);
      await waitForWritableChannel(channel);
      const bufferedBefore = channel.bufferedAmount;
      channel.send(wire);
      this.txPackets += 1;
      if (shouldTracePayload(payload)) {
        this.trace("payload-queued", {
          kind: payload.kind,
          wireSizeBucket: byteSizeBucket(wire.length),
          bufferedBeforeBucket: byteSizeBucket(bufferedBefore),
          bufferedAfterBucket: byteSizeBucket(channel.bufferedAmount),
          txPackets: this.txPackets,
        });
        void this.captureTransportSnapshot("payload-queued");
      }
    });
    this.outgoingQueue = operation.catch(() => undefined);
    return operation;
  }

  close(): void {
    if (this.closed) return;
    this.trace("closing");
    this.closed = true;
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    if (this.signalingCloseTimer !== undefined) window.clearTimeout(this.signalingCloseTimer);
    if (this.disconnectedTimer !== undefined) window.clearTimeout(this.disconnectedTimer);
    if (this.initialIceFailureTimer !== undefined) window.clearTimeout(this.initialIceFailureTimer);
    if (this.initialIceAttemptTimer !== undefined) window.clearTimeout(this.initialIceAttemptTimer);
    if (this.recoveryTimer !== undefined) window.clearTimeout(this.recoveryTimer);
    this.reconnectTimer = undefined;
    this.signalingCloseTimer = undefined;
    this.disconnectedTimer = undefined;
    this.initialIceFailureTimer = undefined;
    this.initialIceAttemptTimer = undefined;
    this.recoveryTimer = undefined;
    this.peerGeneration += 1;
    this.initialIceRetryGeneration += 1;
    this.initialIceRefreshPending = false;
    this.initialIcePreparation = undefined;
    this.recoveryGeneration += 1;
    this.dataChannel?.close();
    this.peerConnection?.close();
    this.socket?.close(1000, "Client closed");
    this.session = undefined;
    this.options.onState("closed");
  }

  private setupPeerConnection(): void {
    if (!this.rtcConfig) throw new Error("WebRTC configuration is not ready");
    const generation = ++this.peerGeneration;
    this.trace("peer-created", { generation });
    let peerConnection: RTCPeerConnection;
    try {
      peerConnection = new RTCPeerConnection(this.rtcConfig);
    } catch (error) {
      if (safeErrorName(error) !== "SyntaxError") throw error;
      const fallback = queryFreeTurnConfiguration(this.rtcConfig);
      if (!fallback) throw error;
      this.queryFreeTurnUrls = true;
      this.rtcConfig = fallback;
      this.trace("turn-query-fallback-applied", undefined, "warn");
      peerConnection = new RTCPeerConnection(fallback);
    }
    this.peerConnection = peerConnection;

    peerConnection.addEventListener("icecandidate", (event) => {
      if (generation !== this.peerGeneration) return;
      this.handleLocalIceCandidate(event.candidate, peerConnection);
    });
    peerConnection.addEventListener("icecandidateerror", (rawEvent) => {
      if (generation !== this.peerGeneration) return;
      this.recordIceCandidateError(rawEvent as RTCPeerConnectionIceErrorEvent);
    });
    peerConnection.addEventListener("icegatheringstatechange", () => {
      if (generation !== this.peerGeneration) return;
      this.trace("ice-gathering-state", { state: peerConnection.iceGatheringState });
      if (peerConnection.iceGatheringState === "complete" && this.localIceDescriptionReady) {
        this.handleLocalIceComplete();
      }
    });
    peerConnection.addEventListener("iceconnectionstatechange", () => {
      if (generation !== this.peerGeneration) return;
      this.trace("ice-connection-state", { state: peerConnection.iceConnectionState });
      if (this.recovering && peerConnection.iceConnectionState === "checking") this.recoverySawChecking = true;
      if (
        this.recovering &&
        this.recoveryNegotiated &&
        this.recoverySawChecking &&
        (peerConnection.iceConnectionState === "connected" || peerConnection.iceConnectionState === "completed")
      ) {
        this.finishIceRecoveryIfConnected();
      }
    });
    peerConnection.addEventListener("signalingstatechange", () => {
      if (generation === this.peerGeneration) this.trace("peer-signaling-state", { state: peerConnection.signalingState });
    });
    peerConnection.addEventListener("connectionstatechange", () => {
      if (generation !== this.peerGeneration) return;
      this.handlePeerConnectionStateChange(peerConnection);
    });
    peerConnection.addEventListener("datachannel", (event) => {
      if (generation === this.peerGeneration) this.attachDataChannel(event.channel, generation);
    });

    if (this.options.role === "creator") {
      this.trace("data-channel-created");
      this.attachDataChannel(
        peerConnection.createDataChannel("directtalk-v1", {
          ordered: true,
          protocol: "directtalk.v1",
        }),
        generation,
      );
    }
  }

  private attachDataChannel(channel: RTCDataChannel, generation: number): void {
    if (this.dataChannel && this.dataChannel !== channel) {
      this.trace("duplicate-data-channel", undefined, "warn");
      channel.close();
      return;
    }
    this.trace("data-channel-attached", { generation, state: channel.readyState });
    this.dataChannel = channel;
    channel.binaryType = "arraybuffer";
    channel.addEventListener("open", () => {
      if (generation !== this.peerGeneration) return;
      this.trace("data-channel-open");
      this.options.onState("authenticating");
      void this.sendHello().catch((error: unknown) => this.fail(error, "handshake-send-hello"));
    });
    channel.addEventListener("message", (event) => {
      if (generation !== this.peerGeneration) return;
      if (typeof event.data !== "string" || event.data.length > 20_000) {
        this.fail(new Error("Получен слишком большой или неподдерживаемый пакет"), "data-channel-packet-format");
        return;
      }
      this.rxPackets += 1;
      if (!this.session) {
        this.trace("data-channel-message", {
          wireSizeBucket: byteSizeBucket(event.data.length),
          phase: "handshake",
          rxPackets: this.rxPackets,
        });
      }
      this.incomingQueue = this.incomingQueue
        .then(() => this.handleDataMessage(event.data))
        .catch((error: unknown) => this.fail(error, "data-channel-message"));
    });
    channel.addEventListener("close", () => {
      if (generation !== this.peerGeneration || this.closed) return;
      this.trace("data-channel-closed", { state: channel.readyState }, "warn");
      void this.captureTransportSnapshot("data-channel-closed");
      if (this.secureNotified) this.beginSessionReconnect("data-channel-close");
      else this.failUnavailableInitialIceRetry("data-channel-close", new Error("Прямое соединение закрыто"));
    });
    channel.addEventListener("error", () => {
      if (generation !== this.peerGeneration) return;
      this.trace("data-channel-error", { state: channel.readyState }, "error");
      void this.captureTransportSnapshot("data-channel-error");
      if (this.secureNotified) this.beginSessionReconnect("data-channel-error");
      else this.failUnavailableInitialIceRetry("data-channel-error", new Error("Ошибка WebRTC DataChannel"));
    });
  }

  private async handleSignalMessage(raw: unknown): Promise<void> {
    if (typeof raw !== "string") throw new Error("Некорректный ответ signaling-сервера");
    const message = JSON.parse(raw) as Record<string, unknown>;
    this.trace("signaling-message", { type: typeof message.type === "string" ? message.type : "invalid" });
    if (message.type === "joined") {
      if (!this.secureNotified && !this.recovering) {
        this.options.onState(this.sessionReconnectActive ? "waiting-reconnect" : "waiting-peer");
      }
      return;
    }
    if (message.type === "peer-ready") {
      this.signalingPeerReady = true;
      if (this.secureNotified) {
        this.beginSessionReconnect("peer-ready");
        return;
      }
      this.options.onState(this.sessionReconnectActive ? "reconnecting" : "connecting-peer");
      if (this.options.role === "creator") await this.createOffer();
      return;
    }
    if (message.type === "peer-left") {
      if (this.recovering) {
        this.handleRecoveryAttemptFailure("peer-left");
      } else if (this.secureNotified) {
        this.beginSessionReconnect("peer-left");
      } else {
        this.resetPeerConnection();
        this.setupPeerConnection();
        this.options.onState(this.sessionReconnectActive ? "waiting-reconnect" : "waiting-peer");
      }
      return;
    }
    if (message.type === "error") {
      if (message.code === "room-full" && this.sessionReconnectActive && !this.secureNotified) {
        this.trace("session-reconnect-room-busy", { attempt: this.reconnectAttempts + 1 }, "warn");
        this.socket?.close(1012, "Resume retry");
        return;
      }
      if (this.recovering) {
        this.handleRecoveryAttemptFailure("signaling-error");
        return;
      }
      if (this.secureNotified) {
        this.trace("signaling-response-error", { code: safeSignalErrorCode(message.code) }, "warn");
        return;
      }
      throw new Error(signalErrorText(message.code));
    }
    if (message.type !== "signal" || !message.payload || typeof message.payload !== "object") {
      throw new Error("Некорректный ответ signaling-сервера");
    }

    const payload = message.payload as Record<string, unknown>;
    const iceGeneration = parseSignaledIceGeneration(payload);
    if (payload.description) await this.handleRemoteDescription(payload.description, iceGeneration);
    else if (payload.candidate) await this.handleRemoteCandidate(payload.candidate, iceGeneration);
    else throw new Error("Некорректные signaling-данные");
  }

  private async createOffer(): Promise<void> {
    if (this.offerStarted) return;
    this.offerStarted = true;
    this.trace("offer-creating");
    const peerConnection = this.requirePeerConnection();
    const peerGeneration = this.peerGeneration;
    const initialIceRetryGeneration = this.initialIceRetryGeneration;
    const offer = await peerConnection.createOffer();
    if (!this.isCurrentPeerOperation(peerGeneration, initialIceRetryGeneration, peerConnection)) return;
    this.iceGeneration = createIceGeneration();
    this.legacyIceGeneration = false;
    this.prepareLocalIceDescription(offer);
    await peerConnection.setLocalDescription(offer);
    if (!this.isCurrentPeerOperation(peerGeneration, initialIceRetryGeneration, peerConnection)) return;
    this.syncLocalIceUsernameFragments(peerConnection.localDescription);
    this.trace("offer-local-set");
    this.signalLocalDescription(offer);
  }

  private createRecoveryOffer(): Promise<void> {
    if (!this.recovering || this.recoveryOfferStarted || !this.signalingPeerReady) return Promise.resolve();
    const operation = this.performCreateRecoveryOffer();
    this.activeNegotiation = operation;
    return operation.finally(() => {
      if (this.activeNegotiation === operation) this.activeNegotiation = undefined;
    });
  }

  private async performCreateRecoveryOffer(): Promise<void> {
    const recoveryGeneration = this.recoveryGeneration;
    this.recoveryOfferStarted = true;
    this.recoveryNegotiated = false;
    this.awaitingRecoveryRemoteDescription = true;
    this.resetIceAttemptDiagnostics();
    this.trace("ice-recovery-offer-creating", { attempt: this.recoveryAttempts });
    const peerConnection = this.requirePeerConnection();
    const offer = await peerConnection.createOffer({ iceRestart: true });
    if (!this.isCurrentRecovery(recoveryGeneration, peerConnection)) return;
    this.iceGeneration = createIceGeneration();
    this.legacyIceGeneration = false;
    this.prepareLocalIceDescription(offer);
    await peerConnection.setLocalDescription(offer);
    if (!this.isCurrentRecovery(recoveryGeneration, peerConnection)) return;
    this.syncLocalIceUsernameFragments(peerConnection.localDescription);
    this.trace("ice-recovery-offer-local-set", { attempt: this.recoveryAttempts });
    this.signalLocalDescription(offer);
  }

  private handleRemoteDescription(value: unknown, iceGeneration?: string): Promise<void> {
    const operation = this.applyRemoteDescription(value, iceGeneration);
    this.activeNegotiation = operation;
    return operation.finally(() => {
      if (this.activeNegotiation === operation) this.activeNegotiation = undefined;
    });
  }

  private async applyRemoteDescription(value: unknown, iceGeneration?: string): Promise<void> {
    if (!value || typeof value !== "object") throw new Error("Некорректное SDP");
    const description = value as RTCSessionDescriptionInit;
    this.trace("remote-description", {
      type: typeof description.type === "string" ? description.type : "invalid",
      recovery: this.recovering,
    });
    if (description.type !== "offer" && description.type !== "answer") throw new Error("Некорректный тип SDP");
    if (this.options.role === "creator" && description.type !== "answer") throw new Error("Ожидался SDP answer");
    if (this.options.role === "joiner" && description.type !== "offer") throw new Error("Ожидался SDP offer");
    if (description.type === "offer" && !this.secureNotified) {
      const peerConnection = this.requirePeerConnection();
      const passiveRetry = Boolean(
        iceGeneration &&
        this.iceGeneration &&
        iceGeneration !== this.iceGeneration &&
        (
          peerConnection.connectionState === "failed" ||
          peerConnection.connectionState === "disconnected" ||
          this.initialIceFailureTimer !== undefined ||
          this.initialIceRetryActive ||
          this.initialIcePreparation
        )
      );
      if (passiveRetry) {
        const failureWasRecorded = this.initialIceFailureTimer !== undefined || this.initialIceRetryActive;
        this.cancelInitialIceFailureTimer();
        this.cancelInitialIceAttemptTimer();
        if (!failureWasRecorded && !this.initialIcePreparation) {
          this.traceInitialIceCandidateSummary("remote-offer");
          this.trace("initial-ice-retry-failed", { attempt: this.initialIceAttempt, trigger: "remote-offer" }, "warn");
        }
        if (!this.initialIceRetryActive && !this.initialIcePreparation) {
          const prepared = await this.startInitialIceRetry("remote-offer", peerConnection);
          if (!prepared || this.closed) return;
        } else if (this.initialIcePreparation) {
          const prepared = await this.initialIcePreparation;
          if (!prepared || this.closed) return;
        }
      } else if (this.initialIcePreparation) {
        const prepared = await this.initialIcePreparation;
        if (!prepared || this.closed) return;
      }
    }
    if (description.type === "answer") {
      if (iceGeneration && this.iceGeneration && iceGeneration !== this.iceGeneration) {
        this.trace("stale-ice-description-ignored", { type: description.type }, "warn");
        return;
      }
      if (!iceGeneration) this.legacyIceGeneration = true;
    } else {
      if (this.secureNotified && iceGeneration && iceGeneration === this.iceGeneration) {
        this.trace("duplicate-ice-description-ignored", { type: description.type }, "warn");
        return;
      }
    }
    if (this.secureNotified && description.type === "offer" && !this.recovering) {
      this.startIceRecovery("remote-offer");
      if (!this.recovering) return;
    } else if (this.secureNotified && description.type === "answer" && !this.recovering) {
      this.trace("unexpected-recovery-answer", undefined, "warn");
      return;
    }
    if (description.type === "offer") {
      this.iceGeneration = iceGeneration;
      this.legacyIceGeneration = !iceGeneration;
      this.localIceDescriptionReady = false;
      this.localIceUsernameFragments.clear();
      this.localDescriptionSignaled = false;
      this.pendingLocalCandidates = [];
    }

    const peerConnection = this.requirePeerConnection();
    const peerGeneration = this.peerGeneration;
    const initialIceRetryGeneration = this.initialIceRetryGeneration;
    const recoveryOperation = this.recovering;
    const recoveryGeneration = this.recoveryGeneration;
    if (this.recovering && description.type === "offer") {
      this.recoveryOfferStarted = true;
      this.recoveryNegotiated = false;
    }
    await peerConnection.setRemoteDescription(description);
    if (!this.isCurrentPeerOperation(peerGeneration, initialIceRetryGeneration, peerConnection)) return;
    if (recoveryOperation && !this.isCurrentRecovery(recoveryGeneration, peerConnection)) return;
    if (this.recovering) this.awaitingRecoveryRemoteDescription = false;
    this.trace("remote-description-set", { type: description.type, queuedCandidates: this.pendingCandidates.length });
    for (const candidate of this.pendingCandidates.splice(0)) {
      await addIceCandidate(peerConnection, candidate);
      if (!this.isCurrentPeerOperation(peerGeneration, initialIceRetryGeneration, peerConnection)) return;
      if (recoveryOperation && !this.isCurrentRecovery(recoveryGeneration, peerConnection)) return;
    }

    if (description.type === "offer") {
      if (this.recovering) {
        this.resetIceAttemptDiagnostics();
      }
      const answer = await peerConnection.createAnswer();
      if (!this.isCurrentPeerOperation(peerGeneration, initialIceRetryGeneration, peerConnection)) return;
      if (recoveryOperation && !this.isCurrentRecovery(recoveryGeneration, peerConnection)) return;
      this.prepareLocalIceDescription(answer);
      await peerConnection.setLocalDescription(answer);
      if (!this.isCurrentPeerOperation(peerGeneration, initialIceRetryGeneration, peerConnection)) return;
      if (recoveryOperation && !this.isCurrentRecovery(recoveryGeneration, peerConnection)) return;
      this.syncLocalIceUsernameFragments(peerConnection.localDescription);
      this.trace("answer-local-set");
      this.signalLocalDescription(answer);
      if (this.recovering && recoveryGeneration === this.recoveryGeneration) {
        this.recoveryNegotiated = true;
        this.finishIceRecoveryIfConnected();
      }
    } else if (this.recovering && recoveryGeneration === this.recoveryGeneration) {
      this.recoveryNegotiated = true;
      this.finishIceRecoveryIfConnected();
    }
  }

  private async handleRemoteCandidate(value: unknown, iceGeneration?: string): Promise<void> {
    const peerConnection = this.requirePeerConnection();
    if (
      !this.iceGeneration &&
      iceGeneration === undefined &&
      (!peerConnection.remoteDescription || (this.recovering && this.awaitingRecoveryRemoteDescription))
    ) {
      this.legacyIceGeneration = true;
    }
    const generationMatches = this.legacyIceGeneration
      ? iceGeneration === undefined
      : Boolean(this.iceGeneration && iceGeneration === this.iceGeneration);
    if (!generationMatches) {
      this.trace("stale-ice-candidate-ignored", undefined, "warn");
      return;
    }
    if (!value || typeof value !== "object") throw new Error("Некорректный ICE candidate");
    const candidate = value as RTCIceCandidateInit;
    if (typeof candidate.candidate !== "string" || candidate.candidate.length > 4_096) {
      throw new Error("Некорректный ICE candidate");
    }
    if (candidate.candidate === "") {
      this.remoteIceComplete = true;
      this.trace("remote-ice-complete");
      if (!peerConnection.remoteDescription || (this.recovering && this.awaitingRecoveryRemoteDescription)) {
        this.pendingCandidates.push(candidate);
      } else {
        await addIceCandidate(peerConnection, candidate);
      }
      this.maybeScheduleSignalingClose();
      return;
    }
    this.remoteCandidateCount += 1;
    this.trace("remote-ice-candidate", {
      count: this.remoteCandidateCount,
      queued: !peerConnection.remoteDescription || (this.recovering && this.awaitingRecoveryRemoteDescription),
      iceType: iceCandidateInitType(candidate),
    });
    if (!peerConnection.remoteDescription || (this.recovering && this.awaitingRecoveryRemoteDescription)) {
      this.pendingCandidates.push(candidate);
    }
    else await addIceCandidate(peerConnection, candidate);
  }

  private sendHello(): Promise<void> {
    if (this.sentHello) return Promise.resolve();
    if (this.helloSendPromise) return this.helloSendPromise;
    if (this.dataChannel?.readyState !== "open") return Promise.resolve();

    this.helloSendPromise = this.prepareAndSendHello();
    return this.helloSendPromise;
  }

  private async prepareAndSendHello(): Promise<void> {
    this.trace("handshake-hello-preparing");
    const local = await this.getLocalHandshake();
    const wire = JSON.stringify(await sealHelloMessage(local.hello, this.options.inviteSecret));
    if (this.dataChannel?.readyState !== "open") throw new Error("Прямое соединение закрыто во время handshake");
    this.dataChannel.send(wire);
    this.sentHello = true;
    this.trace("handshake-hello-sent");
  }

  private getLocalHandshake(): Promise<LocalHandshake> {
    this.localHandshakePromise ??= createLocalHandshake(
      this.options.identity,
      this.options.roomId,
      this.options.inviteSecret,
      this.options.role,
      this.options.displayName,
    );
    return this.localHandshakePromise;
  }

  private async handleDataMessage(raw: string): Promise<void> {
    const value = JSON.parse(raw) as unknown;
    if (!this.session) {
      this.trace("handshake-hello-received");
      if (this.remoteHello) throw new Error("Повторный handshake запрещён");
      const local = await this.getLocalHandshake();
      await this.sendHello();
      const hello = await openHelloMessage(value, this.options.roomId, this.options.inviteSecret, this.options.role);
      const remote = await verifyRemoteHello(
        hello,
        this.options.roomId,
        this.options.inviteSecret,
        this.options.role,
        this.options.expectedCreatorIdentity,
        this.pinnedPeerIdentity,
      );
      this.pinnedPeerIdentity ??= remote.hello.identityKey;
      this.remoteHello = remote.hello;
      this.trace("handshake-identity-verified");
      this.session = await deriveSession(local, remote, this.options.inviteSecret);
      this.trace("handshake-session-derived");
      await this.sendSessionReady();
      return;
    }

    let opened: unknown;
    try {
      opened = await this.session.cipher.open(value);
    } catch (error) {
      this.trace("payload-decrypt-failed", { reason: safeErrorText(error) }, "error");
      throw error;
    }
    let payload: AppPayload;
    try {
      payload = parseAppPayload(opened);
    } catch (error) {
      this.trace("payload-validation-failed", { reason: safeErrorText(error) }, "error");
      throw error;
    }
    if (shouldTracePayload(payload)) {
      this.trace("payload-received", {
        kind: payload.kind,
        wireSizeBucket: byteSizeBucket(raw.length),
        rxPackets: this.rxPackets,
      });
    }
    if (payload.kind === "session-ready") {
      this.receivedSessionReady = true;
      this.notifySecureIfReady();
      return;
    }
    if (!this.receivedSessionReady) throw new Error("Данные получены до подтверждения защищённой сессии");
    try {
      await this.options.onPayload(payload);
    } catch (error) {
      this.trace("payload-handler-failed", { kind: payload.kind, errorName: safeErrorName(error) }, "error");
      throw error;
    }
    if (shouldTracePayload(payload)) this.trace("payload-handler-complete", { kind: payload.kind });
  }

  private async sendSessionReady(): Promise<void> {
    if (!this.session || this.sentSessionReady || this.dataChannel?.readyState !== "open") return;
    this.dataChannel.send(await this.session.cipher.seal({ kind: "session-ready" } satisfies AppPayload));
    this.sentSessionReady = true;
    this.trace("session-ready-sent");
    this.notifySecureIfReady();
  }

  private notifySecureIfReady(): void {
    if (!this.session || !this.remoteHello || !this.sentSessionReady || !this.receivedSessionReady || this.secureNotified) return;
    const reconnected = this.sessionReconnectActive || this.hasEstablishedSession;
    this.secureNotified = true;
    this.sessionReconnectActive = false;
    this.hasEstablishedSession = true;
    this.reconnectAttempts = 0;
    this.cancelInitialIceFailureTimer();
    this.cancelInitialIceAttemptTimer();
    this.initialIceRetryActive = false;
    this.initialIceRefreshPending = false;
    this.initialIceRetryGeneration += 1;
    this.initialIcePreparation = undefined;
    this.trace(reconnected ? "secure-session-restored" : "secure-session-established");
    this.options.onState("secure");
    this.options.onSecure({
      id: this.session.peerId,
      name: this.remoteHello.name,
      identityKey: this.remoteHello.identityKey,
      fingerprint: this.session.peerFingerprint,
      securityCode: this.session.securityCode,
    });
    this.maybeScheduleSignalingClose();
  }

  private handlePeerConnectionStateChange(peerConnection: RTCPeerConnection): void {
    const { connectionState } = peerConnection;
    this.trace("peer-connection-state", { state: connectionState });
    if (connectionState === "connected" || connectionState === "disconnected" || connectionState === "failed") {
      void this.captureTransportSnapshot(connectionState);
    }

    if (connectionState === "connected") {
      if (this.disconnectedTimer !== undefined) window.clearTimeout(this.disconnectedTimer);
      this.disconnectedTimer = undefined;
      this.cancelInitialIceFailureTimer();
      this.cancelInitialIceAttemptTimer();
      if (!this.secureNotified && (this.initialIceRetryActive || this.initialIcePreparation)) {
        const completedAttempt = this.initialIceAttempt;
        if (this.initialIceRefreshPending) {
          this.initialIceRetryGeneration += 1;
          this.initialIcePreparation = undefined;
        }
        this.initialIceRefreshPending = false;
        this.initialIceRetryActive = false;
        this.trace("initial-ice-retry-succeeded", { attempt: completedAttempt });
      }
      if (this.recovering) {
        if (!this.recoveryOfferStarted) this.finishIceRecovery();
        else {
          this.finishIceRecoveryIfConnected();
          if (this.recovering) {
            this.trace("ice-recovery-connected-awaiting-route", { attempt: this.recoveryAttempts });
          }
        }
      } else if (this.recoveryAttempts > 0 && peerConnection.signalingState === "stable") {
        this.finishIceRecovery();
      }
      this.maybeScheduleSignalingClose();
      return;
    }

    if (connectionState === "disconnected") {
      this.cancelSignalingClose();
      if (!this.secureNotified) {
        this.scheduleInitialIceRetry("disconnected", peerConnection);
        return;
      }
      if (this.disconnectedTimer !== undefined || this.recovering) return;
      this.trace("ice-recovery-grace-started", { delay: DISCONNECTED_GRACE_MS }, "warn");
      this.disconnectedTimer = window.setTimeout(() => {
        this.disconnectedTimer = undefined;
        if (this.peerConnection?.connectionState === "disconnected") this.beginSessionReconnect("disconnected");
      }, DISCONNECTED_GRACE_MS);
      return;
    }

    if (connectionState === "failed") {
      this.cancelSignalingClose();
      if (this.disconnectedTimer !== undefined) window.clearTimeout(this.disconnectedTimer);
      this.disconnectedTimer = undefined;
      if (this.secureNotified) this.beginSessionReconnect("failed");
      else this.scheduleInitialIceRetry("failed", peerConnection);
      return;
    }

    if (connectionState === "closed" && !this.closed) this.close();
  }

  private scheduleInitialIceRetry(
    trigger: string,
    peerConnection: RTCPeerConnection,
    reason?: unknown,
    force = false,
  ): void {
    if (
      this.closed ||
      this.secureNotified ||
      this.recovering ||
      this.initialIceFailureTimer !== undefined ||
      this.initialIcePreparation
    ) {
      return;
    }
    this.cancelInitialIceAttemptTimer();
    this.initialIceRetryActive = false;
    this.traceInitialIceCandidateSummary(trigger);
    this.trace("initial-ice-retry-failed", {
      attempt: this.initialIceAttempt,
      trigger,
      ...(reason === undefined ? {} : { reason: safeErrorText(reason) }),
    }, "warn");
    this.initialIceFailureTimer = window.setTimeout(() => {
      this.initialIceFailureTimer = undefined;
      if (
        this.closed ||
        this.secureNotified ||
        peerConnection !== this.peerConnection ||
        (!force && peerConnection.connectionState !== "failed" && peerConnection.connectionState !== "disconnected") ||
        peerConnection.connectionState === "connected"
      ) {
        return;
      }
      if (this.initialIceAttempt >= MAX_INITIAL_ICE_ATTEMPTS) {
        this.exhaustInitialIceRetries(trigger);
        return;
      }
      const channelState = this.dataChannel?.readyState;
      if (channelState === "closed" || channelState === "closing") {
        this.failUnavailableInitialIceRetry("data-channel-close", new Error("Прямое соединение закрыто"));
        return;
      }
      void this.startInitialIceRetry(trigger, peerConnection);
    }, INITIAL_ICE_FAILURE_GRACE_MS);
  }

  private startInitialIceRetry(trigger: string, peerConnection: RTCPeerConnection): Promise<boolean> {
    if (this.initialIcePreparation) return this.initialIcePreparation;
    if (this.closed || this.secureNotified || peerConnection !== this.peerConnection) return Promise.resolve(false);
    if (this.initialIceAttempt >= MAX_INITIAL_ICE_ATTEMPTS) {
      this.exhaustInitialIceRetries(trigger);
      return Promise.resolve(false);
    }
    this.initialIceAttempt += 1;
    this.resetIceAttemptDiagnostics();
    this.initialIceRetryActive = true;
    const initialIceRetryGeneration = ++this.initialIceRetryGeneration;
    const peerGeneration = this.peerGeneration;
    this.trace("initial-ice-retry-started", { attempt: this.initialIceAttempt, trigger }, "warn");
    const rawOperation = this.performInitialIceRetry(
      trigger,
      peerConnection,
      peerGeneration,
      initialIceRetryGeneration,
    );
    const operation = rawOperation
      .then((started) => {
        if (started && this.isCurrentPeerOperation(peerGeneration, initialIceRetryGeneration, peerConnection)) {
          this.armInitialIceAttemptTimer(peerConnection, initialIceRetryGeneration);
        }
        return started;
      })
      .catch((error: unknown) => {
        if (!this.isCurrentPeerOperation(peerGeneration, initialIceRetryGeneration, peerConnection)) return false;
        this.initialIcePreparation = undefined;
        this.initialIceRefreshPending = false;
        this.initialIceRetryActive = false;
        this.scheduleInitialIceRetry("retry-setup", peerConnection, error, true);
        return false;
      });
    this.initialIcePreparation = operation;
    void operation.finally(() => {
      if (this.initialIcePreparation === operation) this.initialIcePreparation = undefined;
    });
    return operation;
  }

  private async performInitialIceRetry(
    _trigger: string,
    peerConnection: RTCPeerConnection,
    peerGeneration: number,
    initialIceRetryGeneration: number,
  ): Promise<boolean> {
    this.initialIceRefreshPending = true;
    const configuration = await rtcConfiguration();
    if (!this.isCurrentPeerOperation(peerGeneration, initialIceRetryGeneration, peerConnection)) return false;
    this.initialIceRefreshPending = false;
    this.applyRtcConfiguration(configuration);
    peerConnection.setConfiguration(this.rtcConfig ?? configuration);
    if (!this.isCurrentPeerOperation(peerGeneration, initialIceRetryGeneration, peerConnection)) return false;

    this.pendingCandidates = [];
    this.remoteCandidateCount = 0;
    this.localIceComplete = false;
    this.remoteIceComplete = false;
    this.candidateSummaryLogged = false;
    this.legacyIceGeneration = false;

    if (this.options.role === "joiner") {
      peerConnection.restartIce();
      this.trace("initial-ice-retry-awaiting-offer", { attempt: this.initialIceAttempt });
      return true;
    }

    this.trace("initial-ice-retry-offer-creating", { attempt: this.initialIceAttempt });
    const offer = await peerConnection.createOffer({ iceRestart: true });
    if (!this.isCurrentPeerOperation(peerGeneration, initialIceRetryGeneration, peerConnection)) return false;
    this.iceGeneration = createIceGeneration();
    this.prepareLocalIceDescription(offer);
    await peerConnection.setLocalDescription(offer);
    if (!this.isCurrentPeerOperation(peerGeneration, initialIceRetryGeneration, peerConnection)) return false;
    this.syncLocalIceUsernameFragments(peerConnection.localDescription);
    this.trace("initial-ice-retry-offer-local-set", { attempt: this.initialIceAttempt });
    this.signalLocalDescription(offer);
    return true;
  }

  private exhaustInitialIceRetries(trigger: string): void {
    this.traceInitialIceCandidateSummary(trigger);
    this.trace("initial-ice-retry-exhausted", { attempt: this.initialIceAttempt, trigger }, "error");
    this.fail(new Error("Не удалось установить WebRTC-соединение"), "peer-connection");
  }

  private failUnavailableInitialIceRetry(trigger: string, error: Error): void {
    if (this.closed) return;
    this.cancelInitialIceFailureTimer();
    this.cancelInitialIceAttemptTimer();
    this.initialIceRetryGeneration += 1;
    this.initialIcePreparation = undefined;
    this.initialIceRefreshPending = false;
    this.initialIceRetryActive = false;
    this.traceInitialIceCandidateSummary(trigger);
    this.trace("initial-ice-retry-failed", { attempt: this.initialIceAttempt, trigger }, "warn");
    this.trace("initial-ice-retry-exhausted", { attempt: this.initialIceAttempt, trigger }, "error");
    this.fail(error, trigger);
  }

  private cancelInitialIceFailureTimer(): void {
    if (this.initialIceFailureTimer !== undefined) window.clearTimeout(this.initialIceFailureTimer);
    this.initialIceFailureTimer = undefined;
  }

  private armInitialIceAttemptTimer(peerConnection: RTCPeerConnection, initialIceRetryGeneration: number): void {
    this.cancelInitialIceAttemptTimer();
    this.initialIceAttemptTimer = window.setTimeout(() => {
      this.initialIceAttemptTimer = undefined;
      if (
        this.closed ||
        this.secureNotified ||
        peerConnection !== this.peerConnection ||
        initialIceRetryGeneration !== this.initialIceRetryGeneration ||
        peerConnection.connectionState === "connected"
      ) {
        return;
      }
      this.initialIceRetryActive = false;
      this.scheduleInitialIceRetry("timeout", peerConnection, undefined, true);
    }, INITIAL_ICE_ATTEMPT_TIMEOUT_MS);
  }

  private cancelInitialIceAttemptTimer(): void {
    if (this.initialIceAttemptTimer !== undefined) window.clearTimeout(this.initialIceAttemptTimer);
    this.initialIceAttemptTimer = undefined;
  }

  private isCurrentPeerOperation(
    peerGeneration: number,
    initialIceRetryGeneration: number,
    peerConnection: RTCPeerConnection,
  ): boolean {
    return !this.closed &&
      peerGeneration === this.peerGeneration &&
      initialIceRetryGeneration === this.initialIceRetryGeneration &&
      peerConnection === this.peerConnection;
  }

  private startIceRecovery(trigger: string): void {
    if (this.closed || this.recovering) return;
    if (!this.secureNotified || !this.session || !this.peerConnection || this.dataChannel?.readyState !== "open") {
      this.beginSessionReconnect("ice-recovery-unavailable");
      return;
    }
    if (this.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
      this.beginSessionReconnect("ice-recovery-exhausted");
      return;
    }

    this.recovering = true;
    this.recoveryAttempts += 1;
    this.resetIceAttemptDiagnostics();
    this.recoveryGeneration += 1;
    this.recoveryOfferStarted = false;
    this.recoveryNegotiated = false;
    this.recoverySawChecking = false;
    this.awaitingRecoveryRemoteDescription = true;
    this.recoveryStartedAt = Date.now();
    this.pendingCandidates = [];
    this.remoteCandidateCount = 0;
    this.localIceComplete = false;
    this.remoteIceComplete = false;
    this.candidateSummaryLogged = false;
    this.iceGeneration = undefined;
    this.legacyIceGeneration = false;
    this.localIceDescriptionReady = false;
    this.localIceUsernameFragments.clear();
    this.localDescriptionSignaled = false;
    this.pendingLocalCandidates = [];
    this.cancelSignalingClose();
    this.trace("ice-recovery-started", { attempt: this.recoveryAttempts, trigger }, "warn");

    if (!this.socket) this.openSignalingSocket();
    else if (this.socket.readyState === WebSocket.OPEN && this.signalingPeerReady && this.options.role === "creator") {
      void this.createRecoveryOffer().catch(() => this.handleRecoveryAttemptFailure("offer-create"));
    }

    if (!this.recovering || this.closed) return;
    this.recoveryTimer = window.setTimeout(() => {
      this.recoveryTimer = undefined;
      this.handleRecoveryAttemptFailure("timeout");
    }, RECOVERY_TIMEOUT_MS);
  }

  private handleRecoveryAttemptFailure(trigger: string): void {
    if (this.closed || !this.recovering) return;
    if (
      (!this.recoveryOfferStarted && this.peerConnection?.connectionState === "connected") ||
      this.isRecoveredIceRoute()
    ) {
      this.finishIceRecovery();
      return;
    }
    if (this.recoveryTimer !== undefined) window.clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.recovering = false;
    this.recoveryNegotiated = false;
    this.awaitingRecoveryRemoteDescription = false;
    this.pendingCandidates = [];
    this.localIceDescriptionReady = false;
    this.localIceUsernameFragments.clear();
    this.localDescriptionSignaled = false;
    this.pendingLocalCandidates = [];
    const recoveryGeneration = ++this.recoveryGeneration;
    this.trace("ice-recovery-attempt-failed", {
      attempt: this.recoveryAttempts,
      trigger,
      ...this.candidateSummaryDetails(),
    }, "warn");
    this.closeSignalingSocket("recovery-retry");

    if (this.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
      this.beginSessionReconnect("ice-recovery-exhausted");
      return;
    }

    const delay = RECOVERY_RETRY_DELAY_MS * this.recoveryAttempts;
    void this.prepareRecoveryRetry(recoveryGeneration, delay);
  }

  private finishIceRecovery(): void {
    const attempt = this.recoveryAttempts;
    if (this.recoveryTimer !== undefined) window.clearTimeout(this.recoveryTimer);
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    this.recoveryTimer = undefined;
    this.reconnectTimer = undefined;
    this.recovering = false;
    this.recoveryGeneration += 1;
    this.recoveryOfferStarted = false;
    this.recoveryNegotiated = false;
    this.recoverySawChecking = false;
    this.awaitingRecoveryRemoteDescription = false;
    this.pendingCandidates = [];
    this.recoveryAttempts = 0;
    this.trace("ice-recovery-succeeded", {
      attempt,
      durationMs: Math.max(0, Date.now() - this.recoveryStartedAt),
    });
    this.maybeScheduleSignalingClose();
  }

  private async prepareRecoveryRetry(recoveryGeneration: number, delay: number): Promise<void> {
    const peerConnection = this.peerConnection;
    if (!peerConnection) return;
    const activeNegotiation = this.activeNegotiation;
    if (activeNegotiation) await activeNegotiation.catch(() => undefined);
    if (this.closed || recoveryGeneration !== this.recoveryGeneration || peerConnection !== this.peerConnection) return;
    try {
      if (peerConnection.signalingState === "have-local-offer") {
        await peerConnection.setLocalDescription({ type: "rollback" });
      } else if (peerConnection.signalingState === "have-remote-offer") {
        await peerConnection.setRemoteDescription({ type: "rollback" });
      } else if (peerConnection.signalingState !== "stable") {
        throw new Error("WebRTC signaling state cannot be rolled back");
      }
    } catch {
      if (!this.closed && recoveryGeneration === this.recoveryGeneration) {
        this.fail(new Error("Не удалось подготовить повторное восстановление"), "ice-recovery-rollback");
      }
      return;
    }
    if (this.closed || recoveryGeneration !== this.recoveryGeneration || peerConnection !== this.peerConnection) return;
    this.recoveryOfferStarted = false;
    this.recoverySawChecking = false;
    if (peerConnection.connectionState === "connected") {
      this.finishIceRecovery();
      return;
    }
    this.trace("ice-recovery-retry-scheduled", { attempt: this.recoveryAttempts + 1, delay }, "warn");
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.closed || recoveryGeneration !== this.recoveryGeneration) return;
      if (this.peerConnection?.connectionState === "connected" && this.peerConnection.signalingState === "stable") {
        this.finishIceRecovery();
      } else {
        this.startIceRecovery("retry");
      }
    }, delay);
  }

  private finishIceRecoveryIfConnected(): void {
    if (this.recovering && this.isRecoveredIceRoute()) this.finishIceRecovery();
  }

  private isCurrentRecovery(recoveryGeneration: number, peerConnection: RTCPeerConnection): boolean {
    return this.recovering &&
      recoveryGeneration === this.recoveryGeneration &&
      peerConnection === this.peerConnection;
  }

  private isRecoveredIceRoute(): boolean {
    const peerConnection = this.peerConnection;
    return Boolean(
      this.recovering &&
      this.recoveryNegotiated &&
      this.recoverySawChecking &&
      peerConnection?.connectionState === "connected" &&
      (peerConnection.iceConnectionState === "connected" || peerConnection.iceConnectionState === "completed") &&
      peerConnection.signalingState === "stable"
    );
  }

  private maybeScheduleSignalingClose(): void {
    if (
      this.closed ||
      !this.secureNotified ||
      this.recovering ||
      this.signalingCloseTimer !== undefined ||
      this.socket?.readyState !== WebSocket.OPEN ||
      !this.localIceComplete ||
      !this.remoteIceComplete ||
      this.peerConnection?.connectionState !== "connected"
    ) {
      return;
    }
    this.trace("signaling-close-scheduled", { delay: SIGNALING_CLOSE_GRACE_MS });
    this.signalingCloseTimer = window.setTimeout(() => {
      this.signalingCloseTimer = undefined;
      if (
        this.closed ||
        this.recovering ||
        this.peerConnection?.connectionState !== "connected" ||
        !this.localIceComplete ||
        !this.remoteIceComplete
      ) {
        return;
      }
      this.closeSignalingSocket("ice-complete");
    }, SIGNALING_CLOSE_GRACE_MS);
  }

  private cancelSignalingClose(): void {
    if (this.signalingCloseTimer !== undefined) window.clearTimeout(this.signalingCloseTimer);
    this.signalingCloseTimer = undefined;
  }

  private closeSignalingSocket(trigger: string): void {
    const socket = this.socket;
    this.socket = undefined;
    this.signalingGeneration += 1;
    this.signalingPeerReady = false;
    if (!socket) return;
    this.trace("signaling-closing", { trigger });
    socket.close(1000, "Signaling complete");
  }

  private handleLocalIceCandidate(candidate: RTCIceCandidate | null, peerConnection: RTCPeerConnection): void {
    if (!this.localIceDescriptionReady) {
      this.trace("stale-local-ice-event-ignored", { reason: "no-current-local-description" }, "warn");
      return;
    }
    if (!candidate) {
      if (peerConnection.iceGatheringState === "complete") this.handleLocalIceComplete();
      else this.trace("stale-local-ice-event-ignored", { reason: "gathering-not-complete" }, "warn");
      return;
    }
    const usernameFragment = iceCandidateUsernameFragment(candidate);
    if (
      usernameFragment &&
      this.localIceUsernameFragments.size > 0 &&
      !this.localIceUsernameFragments.has(usernameFragment)
    ) {
      this.trace("stale-local-ice-event-ignored", { reason: "username-fragment-mismatch" }, "warn");
      return;
    }
    this.localCandidateCount += 1;
    const iceType = iceCandidateType(candidate);
    incrementCandidateCounter(this.localCandidateTypes, iceType);
    const candidateInit = candidate.toJSON();
    this.trace("local-ice-candidate", {
      count: this.localCandidateCount,
      iceType,
      queued: !this.localDescriptionSignaled,
    });
    if (this.localDescriptionSignaled) this.sendSignal({ candidate: candidateInit });
    else this.pendingLocalCandidates.push(candidateInit);
  }

  private recordIceCandidateError(
    event: Pick<RTCPeerConnectionIceErrorEvent, "errorCode" | "url">,
  ): void {
    const server = safeIceServerDescriptor(event.url);
    const route = `${server.urlScheme}/${server.transport}`;
    this.iceErrorCount += 1;
    if (event.errorCode === 701) this.iceError701Count += 1;
    this.iceErrorRoutes.set(route, (this.iceErrorRoutes.get(route) ?? 0) + 1);
    this.trace("ice-candidate-error", {
      errorCode: event.errorCode,
      urlScheme: server.urlScheme,
      transport: server.transport,
    }, "warn");
  }

  private resetIceAttemptDiagnostics(): void {
    this.localCandidateCount = 0;
    this.localCandidateTypes = createCandidateCounters();
    this.candidateSummaryLogged = false;
    this.iceErrorCount = 0;
    this.iceError701Count = 0;
    this.iceErrorRoutes.clear();
  }

  private prepareLocalIceDescription(description: RTCSessionDescriptionInit): void {
    this.localIceDescriptionReady = true;
    this.localIceUsernameFragments = iceUsernameFragments(description.sdp);
    this.resetIceAttemptDiagnostics();
    this.localIceComplete = false;
    this.localDescriptionSignaled = false;
    this.pendingLocalCandidates = [];
  }

  private syncLocalIceUsernameFragments(description: RTCSessionDescription | null): void {
    const fragments = iceUsernameFragments(description?.sdp);
    if (fragments.size > 0) this.localIceUsernameFragments = fragments;
  }

  private signalLocalDescription(description: RTCSessionDescriptionInit): void {
    if (!this.sendSignal({ description })) return;
    this.localDescriptionSignaled = true;
    for (const candidate of this.pendingLocalCandidates.splice(0)) {
      this.sendSignal({ candidate });
    }
  }

  private handleLocalIceComplete(): void {
    this.traceCandidateSummary();
    if (!this.localIceComplete) {
      this.localIceComplete = true;
      const [usernameFragment] = this.localIceUsernameFragments;
      const candidate = usernameFragment ? { candidate: "", usernameFragment } : { candidate: "" };
      if (this.localDescriptionSignaled) this.sendSignal({ candidate });
      else this.pendingLocalCandidates.push(candidate);
      this.trace("local-ice-complete-signaled");
    }
    this.maybeScheduleSignalingClose();
  }

  private traceCandidateSummary(): void {
    if (this.candidateSummaryLogged) return;
    this.candidateSummaryLogged = true;
    const details = this.candidateSummaryDetails();
    this.trace("ice-gathering-complete", details);
    if (this.relayConfigured && this.localCandidateTypes.relay === 0) {
      this.trace("relay-route-unavailable", details, "warn");
    }
  }

  private traceInitialIceCandidateSummary(trigger: string): void {
    this.trace("initial-ice-candidate-summary", {
      attempt: this.initialIceAttempt,
      trigger,
      ...this.candidateSummaryDetails(),
    }, "warn");
  }

  private candidateSummaryDetails(): {
    count: number;
    hostCandidates: number;
    srflxCandidates: number;
    prflxCandidates: number;
    relayCandidates: number;
    relayConfigured: boolean;
    iceErrorCount: number;
    iceError701Count: number;
    iceErrorRoutes: string;
  } {
    return {
      count: this.localCandidateCount,
      hostCandidates: this.localCandidateTypes.host,
      srflxCandidates: this.localCandidateTypes.srflx,
      prflxCandidates: this.localCandidateTypes.prflx,
      relayCandidates: this.localCandidateTypes.relay,
      relayConfigured: this.relayConfigured,
      iceErrorCount: this.iceErrorCount,
      iceError701Count: this.iceError701Count,
      iceErrorRoutes: [...this.iceErrorRoutes.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([route, count]) => `${route}:${count}`)
        .join(",") || "none",
    };
  }

  private async captureTransportSnapshot(trigger: string): Promise<void> {
    const peerConnection = this.peerConnection;
    const generation = this.peerGeneration;
    if (!peerConnection || this.closed) return;
    try {
      const report = await peerConnection.getStats();
      if (this.closed || generation !== this.peerGeneration || peerConnection !== this.peerConnection) return;
      this.trace("transport-snapshot", {
        trigger,
        ...summarizeTransportStats(report, this.dataChannel),
      });
    } catch {
      if (!this.closed && generation === this.peerGeneration) {
        this.trace("transport-stats-unavailable", { trigger }, "warn");
      }
    }
  }

  private scheduleSignalingReconnect(_reason: string): void {
    if (this.reconnectTimer !== undefined || this.closed || this.secureNotified) return;
    this.resetPeerConnection();
    const delay = Math.min(500 * 2 ** this.reconnectAttempts, 5_000);
    this.reconnectAttempts += 1;
    this.trace("signaling-reconnect-scheduled", { attempt: this.reconnectAttempts, delay }, "warn");
    this.options.onState(this.sessionReconnectActive ? "reconnecting" : "connecting-signaling");
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.closed || this.secureNotified) return;
      this.setupPeerConnection();
      this.openSignalingSocket();
    }, delay);
  }

  private resetPeerConnection(): void {
    this.trace("peer-reset", { generation: this.peerGeneration + 1 }, "warn");
    this.cancelInitialIceFailureTimer();
    this.cancelInitialIceAttemptTimer();
    this.peerGeneration += 1;
    this.initialIceRetryGeneration += 1;
    this.initialIcePreparation = undefined;
    this.initialIceRefreshPending = false;
    this.initialIceRetryActive = false;
    this.initialIceAttempt = 1;
    this.dataChannel?.close();
    this.peerConnection?.close();
    this.dataChannel = undefined;
    this.peerConnection = undefined;
    this.localHandshakePromise = undefined;
    this.helloSendPromise = undefined;
    this.remoteHello = undefined;
    this.session = undefined;
    this.sentHello = false;
    this.sentSessionReady = false;
    this.receivedSessionReady = false;
    this.offerStarted = false;
    this.pendingCandidates = [];
    this.remoteCandidateCount = 0;
    this.resetIceAttemptDiagnostics();
    this.localIceComplete = false;
    this.remoteIceComplete = false;
    this.iceGeneration = undefined;
    this.legacyIceGeneration = false;
    this.localIceDescriptionReady = false;
    this.localIceUsernameFragments.clear();
    this.localDescriptionSignaled = false;
    this.pendingLocalCandidates = [];
    this.signalingPeerReady = false;
    this.recovering = false;
    this.recoveryGeneration += 1;
    this.recoveryOfferStarted = false;
    this.recoveryNegotiated = false;
    this.recoverySawChecking = false;
    this.awaitingRecoveryRemoteDescription = false;
  }

  private beginSessionReconnect(trigger: string): void {
    if (this.closed || (this.sessionReconnectActive && !this.secureNotified)) return;
    this.trace("session-reconnect-started", { trigger }, "warn");
    this.cancelSignalingClose();
    if (this.disconnectedTimer !== undefined) window.clearTimeout(this.disconnectedTimer);
    if (this.recoveryTimer !== undefined) window.clearTimeout(this.recoveryTimer);
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    this.disconnectedTimer = undefined;
    this.recoveryTimer = undefined;
    this.reconnectTimer = undefined;
    this.pinnedPeerIdentity ??= this.remoteHello?.identityKey;
    this.sessionReconnectActive = true;
    this.secureNotified = false;
    this.closeSignalingSocket("session-reconnect");
    this.resetPeerConnection();
    this.options.onState("reconnecting");
    try {
      this.setupPeerConnection();
      this.openSignalingSocket();
    } catch (error) {
      this.fail(error, "session-reconnect-setup");
    }
  }

  private sendSignal(payload: Record<string, unknown>): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      if (this.recovering) this.handleRecoveryAttemptFailure("signaling-send");
      else if (!this.closed && !this.secureNotified) this.fail(new Error("Signaling-соединение недоступно"), "signaling-send");
      return false;
    }
    const signalPayload = this.iceGeneration && !this.legacyIceGeneration
      ? { ...payload, iceGeneration: this.iceGeneration }
      : payload;
    this.socket.send(JSON.stringify({ type: "signal", payload: signalPayload }));
    this.trace("signal-sent", { kind: "description" in payload ? "description" : "candidate" });
    return true;
  }

  private requirePeerConnection(): RTCPeerConnection {
    if (!this.peerConnection) throw new Error("WebRTC не инициализирован");
    return this.peerConnection;
  }

  private fail(error: unknown, stage = this.lastStage): void {
    if (this.closed) return;
    const message = error instanceof Error ? error.message : "Неизвестная ошибка соединения";
    logDiagnostic("connection", "failed", { stage, reason: safeErrorText(error) }, "error");
    this.options.onError(message);
    this.close();
  }

  private trace(
    event: string,
    details?: Record<string, string | number | boolean | null | undefined>,
    level: "info" | "warn" | "error" = "info",
  ): void {
    this.lastStage = event;
    logDiagnostic("connection", event, details, level);
  }
}

export function parseAppPayload(value: unknown): AppPayload {
  if (!value || typeof value !== "object") throw new Error("Некорректное содержимое пакета");
  const payload = value as Record<string, unknown>;
  if (payload.kind === "session-ready") return { kind: "session-ready" };
  if (
    payload.kind === "chat-message" &&
    isUuid(payload.id) &&
    typeof payload.text === "string" &&
    payload.text.length >= 1 &&
    payload.text.length <= 4_000 &&
    typeof payload.createdAt === "number" &&
    Number.isSafeInteger(payload.createdAt) &&
    payload.createdAt > 0
  ) {
    return payload as unknown as AppPayload;
  }
  if (
    payload.kind === "ack" &&
    isUuid(payload.messageId) &&
    (payload.status === "delivered" || payload.status === "read")
  ) {
    return payload as unknown as AppPayload;
  }
  if (
    payload.kind === "photo-offer" &&
    isUuid(payload.id) &&
    isSafePhotoName(payload.name) &&
    isPhotoMimeType(payload.mime) &&
    typeof payload.size === "number" &&
    Number.isSafeInteger(payload.size) &&
    payload.size >= 1 &&
    payload.size <= MAX_PHOTO_BYTES &&
    typeof payload.sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(payload.sha256) &&
    typeof payload.chunks === "number" &&
    Number.isSafeInteger(payload.chunks) &&
    payload.chunks === photoChunkCount(payload.size) &&
    payload.chunks >= 1 &&
    payload.chunks <= MAX_PHOTO_CHUNKS &&
    typeof payload.createdAt === "number" &&
    Number.isSafeInteger(payload.createdAt) &&
    payload.createdAt > 0
  ) {
    return payload as unknown as AppPayload;
  }
  if (payload.kind === "photo-response" && isUuid(payload.id) && typeof payload.accepted === "boolean") {
    return payload as unknown as AppPayload;
  }
  if (
    payload.kind === "photo-chunk" &&
    isUuid(payload.id) &&
    typeof payload.index === "number" &&
    Number.isSafeInteger(payload.index) &&
    payload.index >= 0 &&
    payload.index < MAX_PHOTO_CHUNKS &&
    typeof payload.data === "string" &&
    payload.data.length >= 1 &&
    payload.data.length <= MAX_PHOTO_CHUNK_TEXT &&
    /^[A-Za-z0-9_-]+$/u.test(payload.data)
  ) {
    return payload as unknown as AppPayload;
  }
  if (
    (payload.kind === "photo-complete" || payload.kind === "photo-received") &&
    isUuid(payload.id)
  ) {
    return payload as unknown as AppPayload;
  }
  if (
    payload.kind === "photo-cancel" &&
    isUuid(payload.id) &&
    (payload.reason === "cancelled" ||
      payload.reason === "invalid" ||
      payload.reason === "hash-mismatch" ||
      payload.reason === "unsupported" ||
      payload.reason === "transfer-failed")
  ) {
    return payload as unknown as AppPayload;
  }
  if (payload.kind === "delete-message" && isUuid(payload.messageId)) {
    return payload as unknown as AppPayload;
  }
  if (
    payload.kind === "delete-message-result" &&
    isUuid(payload.messageId) &&
    typeof payload.deleted === "boolean"
  ) {
    return payload as unknown as AppPayload;
  }
  if (payload.kind === "clear-chat-request" && isUuid(payload.id)) {
    return payload as unknown as AppPayload;
  }
  if (payload.kind === "clear-chat-response" && isUuid(payload.id) && typeof payload.accepted === "boolean") {
    return payload as unknown as AppPayload;
  }
  throw new Error("Получен неизвестный или некорректный пакет");
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

async function waitForWritableChannel(channel: RTCDataChannel): Promise<void> {
  const highWaterMark = 512 * 1024;
  if (channel.bufferedAmount <= highWaterMark) return;

  const lowWaterMark = 128 * 1024;
  channel.bufferedAmountLowThreshold = lowWaterMark;
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error("Передача остановилась: буфер DataChannel не освобождается")), 30_000);
    const onLow = () => finish();
    const onClose = () => finish(new Error("Прямое соединение закрыто во время передачи"));
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      channel.removeEventListener("bufferedamountlow", onLow);
      channel.removeEventListener("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    channel.addEventListener("bufferedamountlow", onLow, { once: true });
    channel.addEventListener("close", onClose, { once: true });
    if (channel.bufferedAmount <= lowWaterMark) finish();
  });
}

function signalErrorText(code: unknown): string {
  switch (code) {
    case "room-full":
      return "Эта ссылка уже используется другим собеседником";
    case "peer-unavailable":
      return "Собеседник ещё не подключился";
    case "backend-unavailable":
      return "Signaling-сервер временно недоступен или не настроен";
    case "invalid-join":
    case "invalid-signal":
    case "invalid-message":
    case "invalid-json":
      return "Signaling-сервер отклонил некорректные данные";
    default:
      return "Ошибка signaling-сервера";
  }
}

function safeSignalErrorCode(code: unknown): string {
  return code === "room-full" ||
    code === "peer-unavailable" ||
    code === "backend-unavailable" ||
    code === "invalid-join" ||
    code === "invalid-signal" ||
    code === "invalid-message" ||
    code === "invalid-json"
    ? code
    : "unknown";
}

function createIceGeneration(): string {
  return base64UrlEncode(randomBytes(12));
}

function parseSignaledIceGeneration(payload: Record<string, unknown>): string | undefined {
  if (!("iceGeneration" in payload)) return undefined;
  if (typeof payload.iceGeneration !== "string" || !/^[A-Za-z0-9_-]{16}$/u.test(payload.iceGeneration)) {
    throw new Error("Некорректное поколение ICE");
  }
  return payload.iceGeneration;
}

async function addIceCandidate(peerConnection: RTCPeerConnection, candidate: RTCIceCandidateInit): Promise<void> {
  await peerConnection.addIceCandidate(candidate);
}

function iceCandidateType(candidate: RTCIceCandidate): string {
  return candidate.type || iceCandidateInitType(candidate.toJSON());
}

function iceCandidateUsernameFragment(candidate: RTCIceCandidate): string | undefined {
  if (typeof candidate.usernameFragment === "string" && candidate.usernameFragment) {
    return candidate.usernameFragment;
  }
  return candidate.candidate.match(/(?:^|\s)ufrag\s+([^\s]+)/u)?.[1];
}

function iceUsernameFragments(sdp: string | null | undefined): Set<string> {
  if (!sdp) return new Set();
  return new Set(
    [...sdp.matchAll(/^a=ice-ufrag:([^\r\n]+)\r?$/gmu)]
      .map((match) => match[1]?.trim())
      .filter((value): value is string => Boolean(value)),
  );
}

function iceCandidateInitType(candidate: RTCIceCandidateInit): string {
  return candidate.candidate?.match(/\styp\s(host|srflx|prflx|relay)(?:\s|$)/iu)?.[1]?.toLowerCase() ?? "unknown";
}

type CandidateType = "host" | "srflx" | "prflx" | "relay";
type CandidateCounters = Record<CandidateType, number>;
type StatsRecord = Record<string, unknown> & { id?: string; type?: string };

function createCandidateCounters(): CandidateCounters {
  return { host: 0, srflx: 0, prflx: 0, relay: 0 };
}

function incrementCandidateCounter(counters: CandidateCounters, candidateType: string): void {
  if (candidateType === "host" || candidateType === "srflx" || candidateType === "prflx" || candidateType === "relay") {
    counters[candidateType] += 1;
  }
}

function shouldTracePayload(payload: AppPayload): boolean {
  return payload.kind !== "photo-chunk" || payload.index === 0 || payload.index % 32 === 0;
}

function safeIceServerDescriptor(rawUrl: string | null | undefined): { urlScheme: string; transport: string } {
  const value = typeof rawUrl === "string" ? rawUrl : "";
  const urlScheme = value.match(/^(stun|stuns|turn|turns):/iu)?.[1]?.toLowerCase() ?? "unknown";
  const queryTransport = value.match(/[?&]transport=(udp|tcp)(?:&|$)/iu)?.[1]?.toLowerCase();
  const transport = urlScheme === "turns"
    ? "tls"
    : queryTransport ?? (urlScheme === "turn" ? "default" : "unknown");
  return { urlScheme, transport };
}

export function queryFreeTurnConfiguration(configuration: RTCConfiguration): RTCConfiguration | undefined {
  let removedQueryUrl = false;
  const iceServers = (configuration.iceServers ?? []).flatMap((server) => {
    const originalUrls = typeof server.urls === "string" ? [server.urls] : server.urls;
    const urls = originalUrls.filter((url) => {
      const remove = /^(?:turn|turns):[^?]+\?/iu.test(url);
      if (remove) removedQueryUrl = true;
      return !remove;
    });
    if (!urls.length) return [];
    return [{ ...server, urls: typeof server.urls === "string" && urls.length === 1 ? urls[0] : urls }];
  });
  if (!removedQueryUrl || !iceServers.some((server) => {
    const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
    return urls.some((url) => /^(?:turn|turns):/iu.test(url));
  })) {
    return undefined;
  }
  return { ...configuration, iceServers };
}

export function summarizeTransportStats(
  report: RTCStatsReport,
  channel?: Pick<RTCDataChannel, "readyState" | "bufferedAmount">,
): Record<string, string | number | boolean | undefined> {
  const records: StatsRecord[] = [];
  report.forEach((record) => records.push(record as unknown as StatsRecord));
  const byId = new Map(records.flatMap((record) => typeof record.id === "string" ? [[record.id, record] as const] : []));
  const transport = records.find((record) => record.type === "transport" && typeof record.selectedCandidatePairId === "string");
  const selectedPairId = typeof transport?.selectedCandidatePairId === "string" ? transport.selectedCandidatePairId : undefined;
  const selectedPair = (selectedPairId ? byId.get(selectedPairId) : undefined) ?? records
    .filter((record) => record.type === "candidate-pair" && record.state === "succeeded" && (record.nominated === true || record.selected === true))
    .sort((left, right) => safeStatNumber(right.bytesSent) - safeStatNumber(left.bytesSent))[0];
  const localCandidate = typeof selectedPair?.localCandidateId === "string" ? byId.get(selectedPair.localCandidateId) : undefined;
  const remoteCandidate = typeof selectedPair?.remoteCandidateId === "string" ? byId.get(selectedPair.remoteCandidateId) : undefined;

  return {
    channelState: channel?.readyState ?? "missing",
    bufferedAmountBucket: byteSizeBucket(channel?.bufferedAmount ?? 0),
    localRouteType: safeCandidateType(localCandidate?.candidateType),
    remoteRouteType: safeCandidateType(remoteCandidate?.candidateType),
    protocol: safeTransportName(localCandidate?.protocol),
    relayProtocol: safeTransportName(localCandidate?.relayProtocol ?? remoteCandidate?.relayProtocol),
    pairState: safePairState(selectedPair?.state),
    nominated: selectedPair?.nominated === true,
    bytesSentBucket: optionalByteSizeBucket(selectedPair?.bytesSent),
    bytesReceivedBucket: optionalByteSizeBucket(selectedPair?.bytesReceived),
    packetsSent: optionalStatNumber(selectedPair?.packetsSent),
    packetsReceived: optionalStatNumber(selectedPair?.packetsReceived),
    currentRoundTripTimeMs: optionalScaledStatNumber(selectedPair?.currentRoundTripTime, 1_000),
    availableOutgoingBitrateKbps: optionalScaledStatNumber(selectedPair?.availableOutgoingBitrate, 0.001),
  };
}

function safeCandidateType(value: unknown): string {
  return value === "host" || value === "srflx" || value === "prflx" || value === "relay" ? value : "unknown";
}

function safeTransportName(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const normalized = value.toLowerCase();
  return normalized === "udp" || normalized === "tcp" || normalized === "tls" ? normalized : "unknown";
}

function safePairState(value: unknown): string {
  return value === "frozen" || value === "waiting" || value === "in-progress" || value === "failed" || value === "succeeded"
    ? value
    : "unknown";
}

function safeStatNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function optionalStatNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function optionalByteSizeBucket(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? byteSizeBucket(value) : undefined;
}

function optionalScaledStatNumber(value: unknown, scale: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value * scale) : undefined;
}

function byteSizeBucket(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 256) return "1-255B";
  if (value < 1_024) return "256B-1KiB";
  if (value < 16 * 1_024) return "1-16KiB";
  if (value < 128 * 1_024) return "16-128KiB";
  if (value < 512 * 1_024) return "128-512KiB";
  return "512KiB+";
}

function safeErrorName(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(error.name) ? error.name : "Error";
}
