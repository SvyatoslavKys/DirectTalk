import { rtcConfiguration, signalingUrl } from "./config";
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

export type ConnectionState =
  | "connecting-signaling"
  | "waiting-peer"
  | "connecting-peer"
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
  private outgoingQueue: Promise<void> = Promise.resolve();
  private reconnectTimer?: number;
  private reconnectAttempts = 0;
  private peerGeneration = 0;
  private lastStage = "created";
  private localCandidateCount = 0;
  private remoteCandidateCount = 0;
  private rtcConfig?: RTCConfiguration;
  private startPromise?: Promise<void>;

  constructor(private readonly options: ConnectionOptions) {}

  connect(): void {
    if (this.socket || this.startPromise || this.closed || this.secureNotified) return;
    this.trace("connect", { role: this.options.role });
    this.options.onState("connecting-signaling");
    const operation = this.startConnection();
    this.startPromise = operation;
    void operation
      .catch((error: unknown) => this.fail(error, "rtc-configuration"))
      .finally(() => {
        if (this.startPromise === operation) this.startPromise = undefined;
      });
  }

  private async startConnection(): Promise<void> {
    this.rtcConfig = await rtcConfiguration();
    if (this.closed) return;
    const serverCount = this.rtcConfig.iceServers?.length ?? 0;
    const relayEnabled = this.rtcConfig.iceServers?.some((server) => {
      const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
      return urls.some((url) => /^(?:turn|turns):/iu.test(url));
    }) ?? false;
    this.trace("rtc-configuration-ready", { serverCount, relayEnabled });
    if (!this.peerConnection) this.setupPeerConnection();
    this.openSignalingSocket();
  }

  private openSignalingSocket(): void {
    if (this.socket || this.closed || this.secureNotified) return;
    this.trace("signaling-opening");
    let socket: WebSocket;
    try {
      socket = new WebSocket(signalingUrl());
    } catch (error) {
      this.fail(error, "signaling-constructor");
      return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket || this.closed) return;
      this.trace("signaling-open");
      this.reconnectAttempts = 0;
      socket.send(JSON.stringify({ type: "join", roomId: this.options.roomId, role: this.options.role }));
      this.trace("signaling-join-sent");
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || this.closed) return;
      this.incomingQueue = this.incomingQueue
        .then(() => this.handleSignalMessage(event.data))
        .catch((error: unknown) => this.fail(error, "signaling-message"));
    });
    socket.addEventListener("error", () => {
      // The close event schedules a reconnect. Browsers intentionally expose no
      // useful details for WebSocket connection errors.
      this.trace("signaling-error", undefined, "warn");
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.trace("signaling-closed", { code: event.code, clean: event.wasClean }, event.wasClean ? "info" : "warn");
      if (!this.closed && !this.secureNotified) this.scheduleSignalingReconnect(event.reason);
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
      channel.send(wire);
      this.trace("payload-sent", { kind: payload.kind });
    });
    this.outgoingQueue = operation.catch(() => undefined);
    return operation;
  }

  close(): void {
    if (this.closed) return;
    this.trace("closing");
    this.closed = true;
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.peerGeneration += 1;
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
    const peerConnection = new RTCPeerConnection(this.rtcConfig);
    this.peerConnection = peerConnection;

    peerConnection.addEventListener("icecandidate", (event) => {
      if (generation !== this.peerGeneration) return;
      if (event.candidate) {
        this.localCandidateCount += 1;
        this.trace("local-ice-candidate", {
          count: this.localCandidateCount,
          iceType: iceCandidateType(event.candidate),
        });
        this.sendSignal({ candidate: event.candidate.toJSON() });
      } else {
        this.trace("ice-gathering-complete", { count: this.localCandidateCount });
      }
    });
    peerConnection.addEventListener("icegatheringstatechange", () => {
      if (generation === this.peerGeneration) this.trace("ice-gathering-state", { state: peerConnection.iceGatheringState });
    });
    peerConnection.addEventListener("iceconnectionstatechange", () => {
      if (generation === this.peerGeneration) this.trace("ice-connection-state", { state: peerConnection.iceConnectionState });
    });
    peerConnection.addEventListener("signalingstatechange", () => {
      if (generation === this.peerGeneration) this.trace("peer-signaling-state", { state: peerConnection.signalingState });
    });
    peerConnection.addEventListener("connectionstatechange", () => {
      if (generation !== this.peerGeneration) return;
      this.trace("peer-connection-state", { state: peerConnection.connectionState });
      if (peerConnection.connectionState === "failed") this.fail(new Error("Не удалось установить WebRTC-соединение"), "peer-connection");
      if (peerConnection.connectionState === "closed" && !this.closed) this.close();
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
      this.trace("data-channel-message", { bytes: event.data.length, phase: this.session ? "encrypted" : "handshake" });
      this.incomingQueue = this.incomingQueue
        .then(() => this.handleDataMessage(event.data))
        .catch((error: unknown) => this.fail(error, "data-channel-message"));
    });
    channel.addEventListener("close", () => {
      if (generation === this.peerGeneration && !this.closed) this.fail(new Error("Прямое соединение закрыто"), "data-channel-close");
    });
    channel.addEventListener("error", () => {
      if (generation === this.peerGeneration) this.fail(new Error("Ошибка WebRTC DataChannel"), "data-channel-error");
    });
  }

  private async handleSignalMessage(raw: unknown): Promise<void> {
    if (typeof raw !== "string") throw new Error("Некорректный ответ signaling-сервера");
    const message = JSON.parse(raw) as Record<string, unknown>;
    this.trace("signaling-message", { type: typeof message.type === "string" ? message.type : "invalid" });
    if (message.type === "joined") {
      this.options.onState("waiting-peer");
      return;
    }
    if (message.type === "peer-ready") {
      this.options.onState("connecting-peer");
      if (this.options.role === "creator") await this.createOffer();
      return;
    }
    if (message.type === "peer-left") {
      if (!this.secureNotified) {
        this.resetPeerConnection();
        this.setupPeerConnection();
        this.options.onState("waiting-peer");
      }
      return;
    }
    if (message.type === "error") {
      throw new Error(signalErrorText(message.code));
    }
    if (message.type !== "signal" || !message.payload || typeof message.payload !== "object") {
      throw new Error("Некорректный ответ signaling-сервера");
    }

    const payload = message.payload as Record<string, unknown>;
    if (payload.description) await this.handleRemoteDescription(payload.description);
    else if (payload.candidate) await this.handleRemoteCandidate(payload.candidate);
    else throw new Error("Некорректные signaling-данные");
  }

  private async createOffer(): Promise<void> {
    if (this.offerStarted) return;
    this.offerStarted = true;
    this.trace("offer-creating");
    const peerConnection = this.requirePeerConnection();
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    this.trace("offer-local-set");
    this.sendSignal({ description: offer });
  }

  private async handleRemoteDescription(value: unknown): Promise<void> {
    if (!value || typeof value !== "object") throw new Error("Некорректное SDP");
    const description = value as RTCSessionDescriptionInit;
    this.trace("remote-description", { type: typeof description.type === "string" ? description.type : "invalid" });
    if (description.type !== "offer" && description.type !== "answer") throw new Error("Некорректный тип SDP");
    if (this.options.role === "creator" && description.type !== "answer") throw new Error("Ожидался SDP answer");
    if (this.options.role === "joiner" && description.type !== "offer") throw new Error("Ожидался SDP offer");

    const peerConnection = this.requirePeerConnection();
    await peerConnection.setRemoteDescription(description);
    this.trace("remote-description-set", { type: description.type, queuedCandidates: this.pendingCandidates.length });
    for (const candidate of this.pendingCandidates.splice(0)) await peerConnection.addIceCandidate(candidate);

    if (description.type === "offer") {
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      this.trace("answer-local-set");
      this.sendSignal({ description: answer });
    }
  }

  private async handleRemoteCandidate(value: unknown): Promise<void> {
    if (!value || typeof value !== "object") throw new Error("Некорректный ICE candidate");
    const candidate = value as RTCIceCandidateInit;
    if (typeof candidate.candidate !== "string" || candidate.candidate.length > 4_096) {
      throw new Error("Некорректный ICE candidate");
    }
    const peerConnection = this.requirePeerConnection();
    this.remoteCandidateCount += 1;
    this.trace("remote-ice-candidate", {
      count: this.remoteCandidateCount,
      queued: !peerConnection.remoteDescription,
      iceType: iceCandidateInitType(candidate),
    });
    if (!peerConnection.remoteDescription) this.pendingCandidates.push(candidate);
    else await peerConnection.addIceCandidate(candidate);
  }

  private async sendHello(): Promise<void> {
    if (this.sentHello || this.dataChannel?.readyState !== "open") return;
    this.trace("handshake-hello-preparing");
    const local = await this.getLocalHandshake();
    this.dataChannel.send(JSON.stringify(await sealHelloMessage(local.hello, this.options.inviteSecret)));
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
      );
      this.remoteHello = remote.hello;
      this.trace("handshake-identity-verified");
      this.session = await deriveSession(local, remote, this.options.inviteSecret);
      this.trace("handshake-session-derived");
      await this.sendSessionReady();
      return;
    }

    const payload = parseAppPayload(await this.session.cipher.open(value));
    this.trace("payload-received", { kind: payload.kind });
    if (payload.kind === "session-ready") {
      this.receivedSessionReady = true;
      this.notifySecureIfReady();
      return;
    }
    if (!this.receivedSessionReady) throw new Error("Данные получены до подтверждения защищённой сессии");
    await this.options.onPayload(payload);
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
    this.secureNotified = true;
    this.trace("secure-session-established");
    this.options.onState("secure");
    this.options.onSecure({
      id: this.session.peerId,
      name: this.remoteHello.name,
      identityKey: this.remoteHello.identityKey,
      fingerprint: this.session.peerFingerprint,
      securityCode: this.session.securityCode,
    });
    const signalingSocket = this.socket;
    this.socket = undefined;
    signalingSocket?.close(1000, "Signaling complete");
  }

  private scheduleSignalingReconnect(_reason: string): void {
    if (this.reconnectTimer !== undefined || this.closed || this.secureNotified) return;
    this.resetPeerConnection();
    const delay = Math.min(500 * 2 ** this.reconnectAttempts, 5_000);
    this.reconnectAttempts += 1;
    this.trace("signaling-reconnect-scheduled", { attempt: this.reconnectAttempts, delay }, "warn");
    this.options.onState("connecting-signaling");
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.closed || this.secureNotified) return;
      this.setupPeerConnection();
      this.openSignalingSocket();
    }, delay);
  }

  private resetPeerConnection(): void {
    this.trace("peer-reset", { generation: this.peerGeneration + 1 }, "warn");
    this.peerGeneration += 1;
    this.dataChannel?.close();
    this.peerConnection?.close();
    this.dataChannel = undefined;
    this.peerConnection = undefined;
    this.localHandshakePromise = undefined;
    this.remoteHello = undefined;
    this.session = undefined;
    this.sentHello = false;
    this.sentSessionReady = false;
    this.receivedSessionReady = false;
    this.offerStarted = false;
    this.pendingCandidates = [];
    this.localCandidateCount = 0;
    this.remoteCandidateCount = 0;
  }

  private sendSignal(payload: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      if (!this.closed && !this.secureNotified) this.fail(new Error("Signaling-соединение недоступно"), "signaling-send");
      return;
    }
    this.socket.send(JSON.stringify({ type: "signal", payload }));
    this.trace("signal-sent", { kind: "description" in payload ? "description" : "candidate" });
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

function iceCandidateType(candidate: RTCIceCandidate): string {
  return candidate.type || iceCandidateInitType(candidate.toJSON());
}

function iceCandidateInitType(candidate: RTCIceCandidateInit): string {
  return candidate.candidate?.match(/\styp\s(host|srflx|prflx|relay)(?:\s|$)/iu)?.[1]?.toLowerCase() ?? "unknown";
}
