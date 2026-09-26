import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import QRCode from "qrcode";
import { OxalisMark, type OxalisState } from "./components/OxalisMark";
import {
  DirectTalkConnection,
  type AppPayload,
  type ConnectionState,
  type PhotoCancelReason,
  type PhotoOfferPayload,
  type SecurePeer,
} from "./lib/connection";
import {
  db,
  getOrCreateIdentity,
  loadAttachments,
  loadMessages,
  type StoredAttachment,
  type StoredContact,
  type StoredMessage,
} from "./lib/database";
import {
  clearInvitationFromAddressBar,
  createInvitation,
  decodeInvitationSecret,
  invitationUrl,
  readInvitationFromLocation,
  type Invitation,
} from "./lib/invite";
import {
  languageLocale,
  localizeRuntimeMessage,
  readLanguagePreference,
  resolveLanguage,
  translate,
  writeLanguagePreference,
  type Language,
  type LanguagePreference,
  type TranslationKey,
} from "./lib/i18n";
import {
  decodePhotoChunk,
  encodePhotoChunk,
  expectedPhotoChunkBytes,
  formatFileSize,
  hashPhoto,
  photoChunkCount,
  validatePhotoFile,
  validatePhotoSignature,
} from "./lib/photos";
import type { IdentityKeys, PeerRole } from "./lib/protocol";
import {
  clearDiagnostics,
  formatDiagnosticReport,
  getDiagnosticEntries,
  initializeDiagnostics,
  logDiagnostic,
  safeErrorText,
  subscribeDiagnostics,
} from "./lib/diagnostics";
import { APP_VERSION } from "./lib/version";
import { appSounds, readSoundEnabled, writeSoundEnabled } from "./lib/sounds";
import {
  clearResumableSession,
  readResumableSession,
  updateResumablePeerIdentity,
  writeResumableSession,
} from "./lib/sessionResume";

type Screen = "loading" | "home" | "waiting" | "chat" | "error";
type ThemeId = "lime" | "aqua" | "midnight";
type PhotoTransferStatus = "preparing" | "waiting" | "transferring" | "receiving" | "complete" | "declined" | "cancelled" | "failed";
type DeleteScope = "local" | "everyone";

const SPLASH_DURATION_MS = 1_900;
const SPLASH_REDUCED_DURATION_MS = 650;
const THEME_COLORS: Record<ThemeId, string> = {
  lime: "#dcece7",
  aqua: "#dcecf2",
  midnight: "#121323",
};

interface DeleteConfirmation {
  messageId: string;
  scope: DeleteScope;
}

interface PhotoTransfer {
  id: string;
  direction: "outgoing" | "incoming";
  name: string;
  size: number;
  progress: number;
  status: PhotoTransferStatus;
  error?: string;
}

interface IncomingPhotoBuffer {
  offer: PhotoOfferPayload;
  chunks: Uint8Array<ArrayBuffer>[];
  receivedBytes: number;
}

const themeOptions: Array<{ id: ThemeId; label: string; colors: [string, string] }> = [
  { id: "lime", label: "Lime 2003", colors: ["#8ed329", "#eaffba"] },
  { id: "aqua", label: "Aqua 2000", colors: ["#40b9cf", "#c9f7fb"] },
  { id: "midnight", label: "Night 2005", colors: ["#7867e8", "#17172b"] },
];

const classicEmoji = [
  "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🙂",
  "😉", "😊", "😎", "😍", "😘", "🤔", "😐", "🙄",
  "😴", "😢", "😭", "😡", "🤯", "😇", "🤓", "🥳",
  "👍", "👎", "👏", "🙏", "💚", "💔", "🔥", "✨",
  "🎉", "🌼", "☕", "🍺", "🚀", "💾", "☎️", "👋",
];

const stateLabelKeys: Record<ConnectionState, TranslationKey> = {
  "connecting-signaling": "state.connectingSignaling",
  "waiting-peer": "state.waitingPeer",
  "connecting-peer": "state.connectingPeer",
  reconnecting: "state.reconnecting",
  "waiting-reconnect": "state.waitingReconnect",
  authenticating: "state.authenticating",
  secure: "state.secure",
  closed: "state.closed",
};


const diagnosticsCopy: Record<Language, {
  button: string;
  title: string;
  description: string;
  copy: string;
  copied: string;
  share: string;
  clear: string;
  close: string;
}> = {
  en: { button: "Diagnostics", title: "Connection diagnostics", description: "Safe technical events only. Messages, files, keys, invitation secrets, SDP, ICE candidates and IP addresses are excluded.", copy: "Copy logs", copied: "Copied ✓", share: "Share", clear: "Clear", close: "Close" },
  pl: { button: "Diagnostyka", title: "Diagnostyka połączenia", description: "Tylko bezpieczne zdarzenia techniczne. Wiadomości, pliki, klucze, sekrety zaproszeń, SDP, kandydaci ICE i adresy IP są pomijane.", copy: "Kopiuj logi", copied: "Skopiowano ✓", share: "Udostępnij", clear: "Wyczyść", close: "Zamknij" },
  ru: { button: "Диагностика", title: "Диагностика соединения", description: "Только безопасные технические события. Сообщения, файлы, ключи, секрет приглашения, SDP, ICE-кандидаты и IP-адреса не записываются.", copy: "Копировать логи", copied: "Скопировано ✓", share: "Поделиться", clear: "Очистить", close: "Закрыть" },
  uk: { button: "Діагностика", title: "Діагностика з'єднання", description: "Лише безпечні технічні події. Повідомлення, файли, ключі, секрет запрошення, SDP, ICE-кандидати та IP-адреси не записуються.", copy: "Копіювати логи", copied: "Скопійовано ✓", share: "Поділитися", clear: "Очистити", close: "Закрити" },
};

export default function App() {
  const [languagePreference, setLanguagePreference] = useState<LanguagePreference>(() => readLanguagePreference());
  const language = resolveLanguage(languagePreference);
  const t = (key: TranslationKey, params?: Record<string, string | number>) => translate(language, key, params);
  const [screen, setScreen] = useState<Screen>("loading");
  const [identity, setIdentity] = useState<IdentityKeys | null>(null);
  const [incomingInvite, setIncomingInvite] = useState<Invitation | null>(() => readInvitationFromLocation());
  const [displayName, setDisplayName] = useState(() => readLocalName());
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [inviteLink, setInviteLink] = useState("");
  const [qrCode, setQrCode] = useState("");
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting-signaling");
  const [peer, setPeer] = useState<SecurePeer | null>(null);
  const [contact, setContact] = useState<StoredContact | null>(null);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [attachments, setAttachments] = useState<Record<string, StoredAttachment>>({});
  const [incomingPhotoOffers, setIncomingPhotoOffers] = useState<PhotoOfferPayload[]>([]);
  const [photoTransfers, setPhotoTransfers] = useState<Record<string, PhotoTransfer>>({});
  const [photoError, setPhotoError] = useState("");
  const [messageMenuId, setMessageMenuId] = useState<string | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState<DeleteConfirmation | null>(null);
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(() => new Set());
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [incomingClearRequest, setIncomingClearRequest] = useState<string | null>(null);
  const [pendingClearRequest, setPendingClearRequest] = useState<string | null>(null);
  const [historyNotice, setHistoryNotice] = useState("");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [showSecurity, setShowSecurity] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [showThemes, setShowThemes] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [errorDiagnosticId, setErrorDiagnosticId] = useState<number | null>(null);
  const [theme, setTheme] = useState<ThemeId>(() => readTheme());
  const [soundsEnabled, setSoundsEnabled] = useState(() => readSoundEnabled());
  const [showSplash, setShowSplash] = useState(true);
  const [resumableSession, setResumableSession] = useState(() => readResumableSession());
  const connectionRef = useRef<DirectTalkConnection | null>(null);
  const peerRef = useRef<SecurePeer | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const sessionStartedAtRef = useRef(Date.now());
  const outgoingPhotosRef = useRef(new Map<string, File>());
  const sendingPhotosRef = useRef(new Set<string>());
  const incomingPhotosRef = useRef(new Map<string, IncomingPhotoBuffer>());
  const incomingPhotoOffersRef = useRef(new Map<string, PhotoOfferPayload>());
  const cancelledPhotosRef = useRef(new Set<string>());
  const pendingDeleteIdsRef = useRef(new Set<string>());
  const pendingDeleteTimersRef = useRef(new Map<string, number>());
  const pendingDeliveryTimersRef = useRef(new Map<string, number>());
  const incomingClearRequestRef = useRef<string | null>(null);
  const pendingClearRequestRef = useRef<string | null>(null);
  const pendingClearTimerRef = useRef<number | null>(null);
  const connectionGenerationRef = useRef(0);
  const chatGenerationRef = useRef(0);
  const previousScreenRef = useRef<Screen>("loading");
  const startupSoundAtRef = useRef(Number.NEGATIVE_INFINITY);

  const invalidInvite = useMemo(
    () => window.location.hash.startsWith("#invite=") && !incomingInvite,
    [incomingInvite],
  );

  useEffect(() => initializeDiagnostics(), []);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    let frame: number | null = null;
    const syncViewportTop = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const top = Math.min(80, Math.max(0, Math.round(viewport.offsetTop)));
        document.documentElement.style.setProperty("--visual-viewport-top", `${top}px`);
      });
    };

    syncViewportTop();
    viewport.addEventListener("resize", syncViewportTop);
    viewport.addEventListener("scroll", syncViewportTop);
    window.addEventListener("pageshow", syncViewportTop);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", syncViewportTop);
      viewport.removeEventListener("scroll", syncViewportTop);
      window.removeEventListener("pageshow", syncViewportTop);
    };
  }, []);

  useEffect(() => {
    let active = true;
    if (!window.isSecureContext || !crypto.subtle || !window.RTCPeerConnection) {
      showFatalError(translate(language, "error.browser"), "browser-requirements");
      return () => {
        active = false;
      };
    }
    logDiagnostic("app", "browser-requirements-ok");
    void getOrCreateIdentity()
      .then((keys) => {
        if (!active) return;
        logDiagnostic("identity", "ready");
        setIdentity(keys);
        if (invalidInvite) {
          showFatalError(translate(language, "error.invite"), "invitation-validation");
        } else if (!incomingInvite && resumableSession) {
          if (resumableSession.role === "creator" && resumableSession.invitation.creatorIdentity !== keys.publicKeyRaw) {
            clearResumableSession();
            setResumableSession(null);
            setScreen("home");
            return;
          }
          setDisplayName(resumableSession.displayName);
          setInvitation(resumableSession.invitation);
          if (resumableSession.role === "creator" && !resumableSession.expectedPeerIdentity) {
            setInviteLink(invitationUrl(resumableSession.invitation));
          }
          setConnectionState("reconnecting");
          setScreen("waiting");
          logDiagnostic("app", "session-resume-started", { role: resumableSession.role });
          startConnection(resumableSession.invitation, resumableSession.role, keys, {
            resume: true,
            expectedPeerIdentity: resumableSession.expectedPeerIdentity,
            displayName: resumableSession.displayName,
          });
        } else {
          setScreen("home");
        }
      })
      .catch((reason: unknown) => {
        if (!active) return;
        showFatalError(reason instanceof Error ? reason.message : translate(language, "error.identity"), "identity-setup");
      });
    return () => {
      active = false;
    };
  }, [invalidInvite]);

  useEffect(() => () => {
    connectionRef.current?.close();
    for (const timer of pendingDeleteTimersRef.current.values()) window.clearTimeout(timer);
    for (const timer of pendingDeliveryTimersRef.current.values()) window.clearTimeout(timer);
    if (pendingClearTimerRef.current !== null) window.clearTimeout(pendingClearTimerRef.current);
  }, []);

  useEffect(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(
      () => setShowSplash(false),
      reduceMotion ? SPLASH_REDUCED_DURATION_MS : SPLASH_DURATION_MS,
    );
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    appSounds.setEnabled(soundsEnabled);
    writeSoundEnabled(soundsEnabled);
  }, [soundsEnabled]);

  useEffect(() => {
    if (!soundsEnabled) return;

    let active = true;
    let deferredLogged = false;
    const removeFallbackListeners = () => {
      window.removeEventListener("click", retryAfterInteraction);
      window.removeEventListener("keyup", retryAfterInteraction);
    };
    const tryStartupSound = async (source: "load" | "interaction") => {
      const played = await appSounds.play("startup", { resume: source === "interaction" });
      if (!active) return;
      if (played) {
        startupSoundAtRef.current = performance.now();
        removeFallbackListeners();
        logDiagnostic("app", "startup-sound-played", { source });
      } else if (source === "load" && !deferredLogged) {
        deferredLogged = true;
        logDiagnostic("app", "startup-sound-deferred", { reason: "autoplay-policy" });
      }
    };
    function retryAfterInteraction(event: Event) {
      removeFallbackListeners();
      if (event.target instanceof Element && event.target.closest("[data-sound-control]")) return;
      void tryStartupSound("interaction");
    }

    window.addEventListener("click", retryAfterInteraction);
    window.addEventListener("keyup", retryAfterInteraction);
    const timer = window.setTimeout(() => void tryStartupSound("load"), 80);

    return () => {
      active = false;
      window.clearTimeout(timer);
      removeFallbackListeners();
    };
  }, [soundsEnabled]);

  useEffect(() => {
    const previous = previousScreenRef.current;
    previousScreenRef.current = screen;
    if (showSplash) {
      return;
    }
    let connectTimer: number | null = null;
    if (screen === "chat" && previous !== "chat") {
      const startupElapsed = performance.now() - startupSoundAtRef.current;
      const delay = Math.max(0, 720 - startupElapsed);
      if (delay > 0) {
        connectTimer = window.setTimeout(() => void appSounds.play("connect"), delay);
      } else {
        void appSounds.play("connect");
      }
    }
    if (previous === "chat" && screen !== "chat") void appSounds.play("disconnect");
    return () => {
      if (connectTimer !== null) window.clearTimeout(connectTimer);
    };
  }, [screen, showSplash]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[theme]);
    try {
      localStorage.setItem("directtalk.theme", theme);
    } catch {
      // Theme persistence is optional.
    }
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = languageLocale[language];
    writeLanguagePreference(languagePreference);
  }, [language, languagePreference]);

  useEffect(() => {
    if (!inviteLink) {
      setQrCode("");
      return;
    }
    void QRCode.toDataURL(inviteLink, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 260,
      color: { dark: "#081119", light: "#f7faf8" },
    }).then(setQrCode).catch((reason) => {
      logDiagnostic("invite", "qr-generation-failed", { reason: safeErrorText(reason) }, "warn");
      setQrCode("");
    });
  }, [inviteLink]);

  useEffect(() => {
    const list = messageListRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages, incomingPhotoOffers, incomingClearRequest, historyNotice]);

  useEffect(() => {
    const markVisibleMessagesRead = () => {
      if (document.visibilityState !== "visible" || !peerRef.current || !connectionRef.current) return;
      const unread = messages.filter((message) => message.sender === "peer" && message.status === "delivered");
      for (const message of unread) {
        void acknowledgeMessage(connectionRef.current, message.id, "read").catch(handleLocalError);
        void db.messages.update(message.id, { status: "read" }).catch(handleLocalError);
      }
      if (unread.length) {
        const ids = new Set(unread.map((message) => message.id));
        setMessages((current) => current.map((message) => (ids.has(message.id) ? { ...message, status: "read" } : message)));
      }
    };
    document.addEventListener("visibilitychange", markVisibleMessagesRead);
    return () => document.removeEventListener("visibilitychange", markVisibleMessagesRead);
  }, [messages]);

  function startCreator(event: FormEvent) {
    event.preventDefault();
    if (!identity || !validateName()) return;
    const nextInvitation = createInvitation(identity);
    const link = invitationUrl(nextInvitation);
    writeResumableSession({
      invitation: nextInvitation,
      role: "creator",
      displayName: displayName.trim().normalize("NFC"),
    });
    setInvitation(nextInvitation);
    setInviteLink(link);
    setScreen("waiting");
    logDiagnostic("app", "creator-started");
    startConnection(nextInvitation, "creator", identity);
  }

  function startJoiner(event: FormEvent) {
    event.preventDefault();
    if (!identity || !incomingInvite || !validateName()) return;
    writeResumableSession({
      invitation: incomingInvite,
      role: "joiner",
      displayName: displayName.trim().normalize("NFC"),
    });
    clearInvitationFromAddressBar();
    setInvitation(incomingInvite);
    setScreen("waiting");
    logDiagnostic("app", "joiner-started");
    startConnection(incomingInvite, "joiner", identity);
    setIncomingInvite(null);
  }

  function validateName(): boolean {
    const normalized = displayName.trim().normalize("NFC");
    if (normalized.length < 1 || normalized.length > 40 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
      setError(t("error.name"));
      return false;
    }
    setDisplayName(normalized);
    try {
      localStorage.setItem("directtalk.displayName", normalized);
    } catch {
      // The chat still works if storage for a preference is unavailable.
    }
    setError("");
    return true;
  }

  function startConnection(
    nextInvitation: Invitation,
    role: PeerRole,
    activeIdentity: IdentityKeys,
    options: { resume?: boolean; expectedPeerIdentity?: string; displayName?: string } = {},
  ) {
    const generation = connectionGenerationRef.current + 1;
    connectionGenerationRef.current = generation;
    connectionRef.current?.close();
    let directConnection: DirectTalkConnection;
    directConnection = new DirectTalkConnection({
      roomId: nextInvitation.roomId,
      inviteSecret: decodeInvitationSecret(nextInvitation),
      role,
      identity: activeIdentity,
      displayName: options.displayName ?? displayName.trim().normalize("NFC"),
      expectedCreatorIdentity: role === "joiner" ? nextInvitation.creatorIdentity : undefined,
      expectedPeerIdentity: options.expectedPeerIdentity,
      resume: options.resume,
      onState: (state) => {
        if (generation !== connectionGenerationRef.current) return;
        logDiagnostic("app", "connection-state", { state });
        setConnectionState(state);
      },
      onSecure: (securePeer) => {
        if (generation !== connectionGenerationRef.current) return;
        logDiagnostic("app", "secure-peer-ready");
        void handleSecurePeer(securePeer, generation).catch(handleLocalError);
      },
      onPayload: (payload) => {
        if (generation !== connectionGenerationRef.current) return;
        return handlePayload(directConnection, payload);
      },
      onError: (message) => {
        if (generation !== connectionGenerationRef.current) return;
        showFatalError(message, "connection-callback");
      },
    });
    connectionRef.current = directConnection;
    directConnection.connect();
  }

  async function handleSecurePeer(securePeer: SecurePeer, generation: number) {
    if (generation !== connectionGenerationRef.current) return;
    sessionStartedAtRef.current = Date.now();
    peerRef.current = securePeer;
    setPeer(securePeer);
    const existing = await db.contacts.get(securePeer.id);
    if (generation !== connectionGenerationRef.current) return;
    const now = Date.now();
    const nextContact: StoredContact = {
      id: securePeer.id,
      name: securePeer.name,
      identityKey: securePeer.identityKey,
      fingerprint: securePeer.fingerprint,
      verified: existing?.verified ?? false,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
    };
    await db.contacts.put(nextContact);
    if (generation !== connectionGenerationRef.current) return;
    const [history, storedAttachments] = await Promise.all([
      loadMessages(securePeer.id),
      loadAttachments(securePeer.id),
    ]);
    if (generation !== connectionGenerationRef.current) return;
    const interruptedPhotoIds = history
      .filter((message) => message.sender === "me" && message.kind === "photo" && message.status === "sending")
      .map((message) => message.id);
    if (interruptedPhotoIds.length) {
      await Promise.all(interruptedPhotoIds.map((id) => db.messages.update(id, { status: "failed" })));
      if (generation !== connectionGenerationRef.current) return;
      for (const id of interruptedPhotoIds) {
        outgoingPhotosRef.current.delete(id);
        sendingPhotosRef.current.delete(id);
      }
    }
    const recoveredHistory = history.map((message) => (
      interruptedPhotoIds.includes(message.id) ? { ...message, status: "failed" as const } : message
    ));
    setContact(nextContact);
    setMessages((current) => mergeStoredMessages(recoveredHistory, current));
    setAttachments(indexAttachments(storedAttachments));
    if (interruptedPhotoIds.length) {
      setPhotoTransfers((current) => {
        const next = { ...current };
        for (const id of interruptedPhotoIds) {
          if (next[id]) next[id] = { ...next[id], status: "failed", error: t("photo.transferFailed") };
        }
        return next;
      });
    }
    updateResumablePeerIdentity(securePeer.identityKey);
    logDiagnostic("storage", "chat-history-loaded", { messages: history.length, attachments: storedAttachments.length });
    setScreen("chat");
    await resendPendingTextMessages(recoveredHistory, generation);
  }

  async function resendPendingTextMessages(history: StoredMessage[], generation: number) {
    const connection = connectionRef.current;
    if (!connection) return;
    const pending = history.filter((message) => (
      message.sender === "me" && message.kind !== "photo" && message.status === "sending"
    ));
    for (const message of pending) {
      if (generation !== connectionGenerationRef.current || connection !== connectionRef.current) return;
      try {
        await connection.send({ kind: "chat-message", id: message.id, text: message.text, createdAt: message.createdAt });
        beginDeliveryWatch(message.id);
        logDiagnostic("chat", "pending-message-requeued");
      } catch (reason) {
        logDiagnostic("chat", "pending-message-requeue-failed", { reason: safeErrorText(reason) }, "warn");
        return;
      }
    }
  }

  function showFatalError(message: string, stage: string) {
    const diagnosticId = logDiagnostic("app", "fatal-error", { stage, reason: safeErrorText(message) }, "error");
    setErrorDiagnosticId(diagnosticId);
    setError(message);
    setScreen("error");
  }

  async function handlePayload(connection: DirectTalkConnection, payload: Exclude<AppPayload, { kind: "session-ready" }>) {
    const currentPeer = peerRef.current;
    if (!currentPeer) return;

    if (payload.kind === "chat-message") {
      const existing = await db.messages.get(payload.id);
      if (existing) {
        if (existing.sender === "peer") {
          logDiagnostic("chat", "incoming-message-duplicate", { status: existing.status });
          await acknowledgeMessage(connection, existing.id, existing.status === "read" ? "read" : "delivered");
        }
        return;
      }
      const status = document.visibilityState === "visible" ? "read" : "delivered";
      const message: StoredMessage = {
        id: payload.id,
        chatId: currentPeer.id,
        sender: "peer",
        text: payload.text,
        createdAt: Math.min(payload.createdAt, Date.now() + 60_000),
        status,
      };
      await db.messages.put(message);
      setMessages((current) => upsertMessage(current, message));
      logDiagnostic("chat", "incoming-message-stored", { status });
      await acknowledgeMessage(connection, message.id, status);
      return;
    }

    if (payload.kind === "ack") {
      const outgoing = await db.messages.get(payload.messageId);
      if (!outgoing || outgoing.sender !== "me" || outgoing.status === "failed") return;
      const nextStatus = outgoing.status === "read" ? "read" : payload.status;
      await db.messages.update(payload.messageId, { status: nextStatus });
      finishDeliveryWatch(payload.messageId);
      setMessages((current) =>
        current.map((message) =>
          message.id === payload.messageId && message.sender === "me" ? { ...message, status: nextStatus } : message,
        ),
      );
      logDiagnostic("chat", "delivery-confirmed", { status: nextStatus });
      return;
    }

    if (payload.kind === "photo-offer") {
      const existing = await db.attachments.get(payload.id);
      if (existing) {
        await connection.send({ kind: "photo-received", id: payload.id });
        return;
      }
      if (incomingPhotosRef.current.has(payload.id)) return;
      if (cancelledPhotosRef.current.has(payload.id)) {
        await connection.send({ kind: "photo-response", id: payload.id, accepted: false });
        return;
      }
      incomingPhotoOffersRef.current.set(payload.id, payload);
      setIncomingPhotoOffers((current) => current.some((offer) => offer.id === payload.id) ? current : [...current, payload]);
      return;
    }

    if (payload.kind === "photo-response") {
      const file = outgoingPhotosRef.current.get(payload.id);
      if (!file) return;
      if (sendingPhotosRef.current.has(payload.id)) return;
      if (!payload.accepted) {
        outgoingPhotosRef.current.delete(payload.id);
        cancelledPhotosRef.current.add(payload.id);
        setPhotoTransfer(payload.id, { status: "declined", error: t("notice.photoDeclined") });
        await updateOutgoingMessageStatus(payload.id, "failed");
        return;
      }
      sendingPhotosRef.current.add(payload.id);
      void sendPhotoChunks(connection, payload.id, file).catch((reason: unknown) => {
        void failOutgoingPhoto(connection, payload.id, reason);
      });
      return;
    }

    if (payload.kind === "photo-chunk") {
      await receivePhotoChunk(connection, payload.id, payload.index, payload.data);
      return;
    }

    if (payload.kind === "photo-complete") {
      await finishIncomingPhoto(connection, currentPeer.id, payload.id);
      return;
    }

    if (payload.kind === "photo-received") {
      if (cancelledPhotosRef.current.has(payload.id)) return;
      outgoingPhotosRef.current.delete(payload.id);
      sendingPhotosRef.current.delete(payload.id);
      cancelledPhotosRef.current.delete(payload.id);
      setPhotoTransfer(payload.id, { status: "complete", progress: 1 });
      await updateOutgoingMessageStatus(payload.id, "delivered");
      return;
    }

    if (payload.kind === "delete-message") {
      const stored = await db.messages.get(payload.messageId);
      const allowed = !stored || (stored.chatId === currentPeer.id && stored.sender === "peer");
      let deleted = allowed;
      if (stored && allowed) {
        try {
          await deleteMessageLocally(payload.messageId);
        } catch {
          deleted = false;
        }
      }
      await connection.send({ kind: "delete-message-result", messageId: payload.messageId, deleted });
      return;
    }

    if (payload.kind === "delete-message-result") {
      if (!pendingDeleteIdsRef.current.has(payload.messageId)) return;
      finishPendingDelete(payload.messageId);
      if (!payload.deleted) {
        setHistoryNotice(t("notice.deleteDenied"));
        return;
      }
      const stored = await db.messages.get(payload.messageId);
      if (stored && (stored.chatId !== currentPeer.id || stored.sender !== "me")) {
        setHistoryNotice(t("notice.invalidDeleteConfirmation"));
        return;
      }
      try {
        if (stored) await deleteMessageLocally(payload.messageId);
        setHistoryNotice(t("notice.deletedEveryone"));
      } catch {
        setHistoryNotice(t("notice.deletedRemoteLocalFailed"));
      }
      return;
    }

    if (payload.kind === "clear-chat-request") {
      if (incomingClearRequestRef.current) {
        if (incomingClearRequestRef.current !== payload.id) {
          await connection.send({ kind: "clear-chat-response", id: payload.id, accepted: false });
        }
        return;
      }
      incomingClearRequestRef.current = payload.id;
      setIncomingClearRequest(payload.id);
      return;
    }

    if (payload.kind === "clear-chat-response") {
      if (pendingClearRequestRef.current !== payload.id) return;
      finishPendingClearRequest();
      if (!payload.accepted) {
        setHistoryNotice(t("notice.clearDeclined"));
        return;
      }
      try {
        await clearChatLocally(currentPeer.id, connection);
        setHistoryNotice(t("notice.clearedEveryone"));
      } catch {
        setHistoryNotice(t("notice.clearedRemoteLocalFailed"));
      }
      return;
    }

    cancelledPhotosRef.current.add(payload.id);
    outgoingPhotosRef.current.delete(payload.id);
    sendingPhotosRef.current.delete(payload.id);
    incomingPhotosRef.current.delete(payload.id);
    incomingPhotoOffersRef.current.delete(payload.id);
    setIncomingPhotoOffers((current) => current.filter((offer) => offer.id !== payload.id));
    setPhotoTransfer(payload.id, { status: payload.reason === "cancelled" ? "cancelled" : "failed", error: photoCancelText(payload.reason, language) });
    const outgoing = await db.messages.get(payload.id);
    if (outgoing?.sender === "me") await updateOutgoingMessageStatus(payload.id, "failed");
  }

  async function sendPhotoChunks(connection: DirectTalkConnection, id: string, file: File) {
    setPhotoTransfer(id, { status: "transferring", progress: 0 });
    const chunks = photoChunkCount(file.size);
    for (let index = 0; index < chunks; index += 1) {
      if (cancelledPhotosRef.current.has(id)) return;
      const data = await encodePhotoChunk(file, index);
      await connection.send({ kind: "photo-chunk", id, index, data });
      if (index === chunks - 1 || index % 8 === 0) {
        setPhotoTransfer(id, { progress: (index + 1) / chunks });
      }
    }
    if (cancelledPhotosRef.current.has(id)) return;
    await connection.send({ kind: "photo-complete", id });
  }

  async function receivePhotoChunk(connection: DirectTalkConnection, id: string, index: number, data: string) {
    const transfer = incomingPhotosRef.current.get(id);
    if (!transfer) {
      if (cancelledPhotosRef.current.has(id)) return;
      cancelledPhotosRef.current.add(id);
      await connection.send({ kind: "photo-cancel", id, reason: "invalid" });
      return;
    }
    try {
      if (index !== transfer.chunks.length) throw new Error(t("error.photoOrder"));
      const bytes = decodePhotoChunk(data);
      if (bytes.byteLength !== expectedPhotoChunkBytes(transfer.offer.size, index)) {
        throw new Error(t("error.photoChunkSize"));
      }
      transfer.chunks.push(bytes);
      transfer.receivedBytes += bytes.byteLength;
      if (transfer.receivedBytes > transfer.offer.size) throw new Error(t("error.photoOverflow"));
      setPhotoTransfer(id, { progress: transfer.receivedBytes / transfer.offer.size });
    } catch (reason) {
      await rejectIncomingPhoto(connection, id, "invalid", reason);
    }
  }

  async function finishIncomingPhoto(connection: DirectTalkConnection, chatId: string, id: string) {
    const transfer = incomingPhotosRef.current.get(id);
    if (!transfer) {
      if (cancelledPhotosRef.current.has(id)) return;
      cancelledPhotosRef.current.add(id);
      await connection.send({ kind: "photo-cancel", id, reason: "invalid" });
      return;
    }
    try {
      if (transfer.chunks.length !== transfer.offer.chunks || transfer.receivedBytes !== transfer.offer.size) {
        throw new Error(t("error.photoIncomplete"));
      }
      const blob = new Blob(transfer.chunks, { type: transfer.offer.mime });
      if (await hashPhoto(blob) !== transfer.offer.sha256) {
        await rejectIncomingPhoto(connection, id, "hash-mismatch", new Error(t("photo.hashMismatch")));
        return;
      }
      await validatePhotoSignature(blob, transfer.offer.mime);
      await ensureImageDecodes(blob, language);
      const createdAt = Math.min(transfer.offer.createdAt, Date.now() + 60_000);
      const status = document.visibilityState === "visible" ? "read" : "delivered";
      const attachment: StoredAttachment = {
        id,
        messageId: id,
        chatId,
        name: transfer.offer.name,
        mime: transfer.offer.mime,
        size: transfer.offer.size,
        sha256: transfer.offer.sha256,
        blob,
        createdAt,
      };
      const message: StoredMessage = {
        id,
        chatId,
        sender: "peer",
        text: "",
        kind: "photo",
        attachmentId: id,
        createdAt,
        status,
      };
      await db.transaction("rw", db.attachments, db.messages, async () => {
        await db.attachments.put(attachment);
        await db.messages.put(message);
      });
      incomingPhotosRef.current.delete(id);
      cancelledPhotosRef.current.delete(id);
      setAttachments((current) => ({ ...current, [id]: attachment }));
      setMessages((current) => upsertMessage(current, message));
      setPhotoTransfer(id, { status: "complete", progress: 1 });
      await connection.send({ kind: "photo-received", id });
      await acknowledgeMessage(connection, id, status);
    } catch (reason) {
      await rejectIncomingPhoto(connection, id, "invalid", reason);
    }
  }

  async function rejectIncomingPhoto(
    connection: DirectTalkConnection,
    id: string,
    reason: PhotoCancelReason,
    error: unknown,
  ) {
    cancelledPhotosRef.current.add(id);
    incomingPhotosRef.current.delete(id);
    incomingPhotoOffersRef.current.delete(id);
    setIncomingPhotoOffers((current) => current.filter((offer) => offer.id !== id));
    setPhotoTransfer(id, {
      status: "failed",
      error: error instanceof Error ? error.message : t("error.photoReceive"),
    });
    await connection.send({ kind: "photo-cancel", id, reason });
  }

  async function failOutgoingPhoto(connection: DirectTalkConnection, id: string, reason: unknown) {
    cancelledPhotosRef.current.add(id);
    outgoingPhotosRef.current.delete(id);
    sendingPhotosRef.current.delete(id);
    setPhotoTransfer(id, {
      status: "failed",
      error: reason instanceof Error ? reason.message : t("error.photoSend"),
    });
    await updateOutgoingMessageStatus(id, "failed");
    try {
      await connection.send({ kind: "photo-cancel", id, reason: "transfer-failed" });
    } catch {
      // The connection may already be closed.
    }
  }

  async function updateOutgoingMessageStatus(id: string, status: StoredMessage["status"]) {
    await db.messages.update(id, { status });
    setMessages((current) => current.map((message) => message.id === id ? { ...message, status } : message));
  }

  function setPhotoTransfer(id: string, patch: Partial<PhotoTransfer>) {
    setPhotoTransfers((current) => {
      const existing = current[id];
      if (!existing) return current;
      return { ...current, [id]: { ...existing, ...patch } };
    });
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();

    const currentPeer = peerRef.current;
    const connection = connectionRef.current;
    if (!text || text.length > 4_000 || !currentPeer || !connection || connectionState !== "secure") return;

    const message: StoredMessage = {
      id: crypto.randomUUID(),
      chatId: currentPeer.id,
      sender: "me",
      text,
      createdAt: Date.now(),
      status: "sending",
    };
    setDraft("");
    await db.messages.put(message);
    setMessages((current) => upsertMessage(current, message));
    try {
      await connection.send({ kind: "chat-message", id: message.id, text: message.text, createdAt: message.createdAt });
      logDiagnostic("chat", "message-queued");
      beginDeliveryWatch(message.id);
    } catch (reason) {
      finishDeliveryWatch(message.id);
      await db.messages.update(message.id, { status: "failed" });
      setMessages((current) => current.map((item) => (item.id === message.id ? { ...item, status: "failed" } : item)));
      setError(reason instanceof Error ? reason.message : t("error.messageSend"));
      logDiagnostic("chat", "message-send-failed", { reason: safeErrorText(reason) }, "error");
    }
  }

  async function handlePhotoSelection(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || connectionState !== "secure") return;

    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const generation = chatGenerationRef.current;
    setPhotoError("");
    try {
      const metadata = validatePhotoFile(file);
      setPhotoTransfers((current) => ({
        ...current,
        [id]: {
          id,
          direction: "outgoing",
          name: metadata.name,
          size: metadata.size,
          progress: 0,
          status: "preparing",
        },
      }));
      await validatePhotoSignature(file, metadata.mime);
      if (generation !== chatGenerationRef.current) return;
      await ensureImageDecodes(file, language);
      if (generation !== chatGenerationRef.current) return;
      const sha256 = await hashPhoto(file);
      if (generation !== chatGenerationRef.current) return;
      const chatId = peerRef.current?.id;
      if (!chatId) throw new Error(t("error.secureNotReady"));

      const attachment: StoredAttachment = {
        id,
        messageId: id,
        chatId,
        name: metadata.name,
        mime: metadata.mime,
        size: metadata.size,
        sha256,
        blob: file,
        createdAt,
      };
      const message: StoredMessage = {
        id,
        chatId,
        sender: "me",
        text: "",
        kind: "photo",
        attachmentId: id,
        createdAt,
        status: "sending",
      };

      const connection = connectionRef.current;
      if (!connection) throw new Error(t("error.secureNotReady"));
      await db.transaction("rw", db.attachments, db.messages, async () => {
        await db.attachments.put(attachment);
        await db.messages.put(message);
      });
      setAttachments((current) => ({ ...current, [id]: attachment }));
      setMessages((current) => upsertMessage(current, message));
      outgoingPhotosRef.current.set(id, file);
      cancelledPhotosRef.current.delete(id);
      setPhotoTransfer(id, { status: "waiting", progress: 0 });
      await connection.send({
        kind: "photo-offer",
        id,
        name: metadata.name,
        mime: metadata.mime,
        size: metadata.size,
        sha256,
        chunks: photoChunkCount(metadata.size),
        createdAt,
      });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : t("error.photoPrepare");
      setPhotoError(message);
      setPhotoTransfer(id, { status: "failed", error: message });
      if (await db.messages.get(id)) await updateOutgoingMessageStatus(id, "failed");
    }
  }

  async function acceptPhotoOffer(offer: PhotoOfferPayload) {
    const connection = connectionRef.current;
    if (!connection) return;
    setPhotoError("");
    cancelledPhotosRef.current.delete(offer.id);
    incomingPhotoOffersRef.current.delete(offer.id);
    setIncomingPhotoOffers((current) => current.filter((item) => item.id !== offer.id));
    incomingPhotosRef.current.set(offer.id, { offer, chunks: [], receivedBytes: 0 });
    setPhotoTransfers((current) => ({
      ...current,
      [offer.id]: {
        id: offer.id,
        direction: "incoming",
        name: offer.name,
        size: offer.size,
        progress: 0,
        status: "receiving",
      },
    }));
    try {
      await connection.send({ kind: "photo-response", id: offer.id, accepted: true });
    } catch (reason) {
      incomingPhotosRef.current.delete(offer.id);
      setPhotoTransfer(offer.id, {
        status: "failed",
        error: reason instanceof Error ? reason.message : t("error.photoStart"),
      });
    }
  }

  async function declinePhotoOffer(offer: PhotoOfferPayload) {
    incomingPhotoOffersRef.current.delete(offer.id);
    setIncomingPhotoOffers((current) => current.filter((item) => item.id !== offer.id));
    cancelledPhotosRef.current.add(offer.id);
    const connection = connectionRef.current;
    if (connection) await connection.send({ kind: "photo-response", id: offer.id, accepted: false });
  }

  async function cancelPhotoTransfer(id: string) {
    cancelledPhotosRef.current.add(id);
    outgoingPhotosRef.current.delete(id);
    sendingPhotosRef.current.delete(id);
    incomingPhotosRef.current.delete(id);
    incomingPhotoOffersRef.current.delete(id);
    setIncomingPhotoOffers((current) => current.filter((offer) => offer.id !== id));
    setPhotoTransfer(id, { status: "cancelled", error: t("photo.cancelled") });
    const storedMessage = await db.messages.get(id);
    if (storedMessage?.sender === "me") await updateOutgoingMessageStatus(id, "failed");
    const connection = connectionRef.current;
    if (connection) {
      try {
        await connection.send({ kind: "photo-cancel", id, reason: "cancelled" });
      } catch {
        // Closing the chat already cancels the transfer locally.
      }
    }
  }

  async function confirmMessageDeletion() {
    const confirmation = deleteConfirmation;
    if (!confirmation) return;
    setDeleteConfirmation(null);
    setMessageMenuId(null);
    setHistoryNotice("");

    try {
      if (outgoingPhotosRef.current.has(confirmation.messageId) || incomingPhotosRef.current.has(confirmation.messageId)) {
        await cancelPhotoTransfer(confirmation.messageId);
      }

      if (confirmation.scope === "local") {
        await deleteMessageLocally(confirmation.messageId);
        setHistoryNotice(t("notice.deletedLocal"));
        return;
      }

      const currentPeer = peerRef.current;
      const connection = connectionRef.current;
      const stored = await db.messages.get(confirmation.messageId);
      if (!currentPeer || !connection || !stored || stored.chatId !== currentPeer.id || stored.sender !== "me") {
        throw new Error(t("notice.deleteOwnOnly"));
      }

      beginPendingDelete(confirmation.messageId);
      await connection.send({ kind: "delete-message", messageId: confirmation.messageId });
    } catch (reason) {
      finishPendingDelete(confirmation.messageId);
      setHistoryNotice(reason instanceof Error ? reason.message : t("notice.deleteRequestFailed"));
    }
  }

  async function deleteMessageLocally(messageId: string): Promise<void> {
    const currentPeer = peerRef.current;
    const stored = await db.messages.get(messageId);
    if (!currentPeer || !stored || stored.chatId !== currentPeer.id) return;
    await db.transaction("rw", db.messages, db.attachments, async () => {
      await db.attachments.where("messageId").equals(messageId).delete();
      await db.messages.delete(messageId);
    });
    setMessages((current) => current.filter((message) => message.id !== messageId));
    setAttachments((current) => removeMessageAttachments(current, messageId));
    setPhotoTransfers((current) => {
      if (!(messageId in current)) return current;
      const next = { ...current };
      delete next[messageId];
      return next;
    });
  }

  function beginPendingDelete(messageId: string) {
    pendingDeleteIdsRef.current.add(messageId);
    setPendingDeleteIds((current) => new Set(current).add(messageId));
    const timer = window.setTimeout(() => {
      if (!pendingDeleteIdsRef.current.has(messageId)) return;
      finishPendingDelete(messageId);
      setHistoryNotice(t("notice.deleteTimeout"));
    }, 15_000);
    pendingDeleteTimersRef.current.set(messageId, timer);
  }

  function finishPendingDelete(messageId: string) {
    pendingDeleteIdsRef.current.delete(messageId);
    const timer = pendingDeleteTimersRef.current.get(messageId);
    if (timer !== undefined) window.clearTimeout(timer);
    pendingDeleteTimersRef.current.delete(messageId);
    setPendingDeleteIds((current) => {
      if (!current.has(messageId)) return current;
      const next = new Set(current);
      next.delete(messageId);
      return next;
    });
  }

  function clearPendingDeletes() {
    pendingDeleteIdsRef.current.clear();
    for (const timer of pendingDeleteTimersRef.current.values()) window.clearTimeout(timer);
    pendingDeleteTimersRef.current.clear();
    setPendingDeleteIds(new Set());
  }

  function beginDeliveryWatch(messageId: string) {
    finishDeliveryWatch(messageId);
    const timer = window.setTimeout(() => {
      pendingDeliveryTimersRef.current.delete(messageId);
      void db.messages.get(messageId).then((message) => {
        if (message?.sender === "me" && message.status === "sending") {
          logDiagnostic("chat", "delivery-still-pending", { durationMs: 8_000 }, "warn");
        }
      }).catch(handleLocalError);
    }, 8_000);
    pendingDeliveryTimersRef.current.set(messageId, timer);
  }

  function finishDeliveryWatch(messageId: string) {
    const timer = pendingDeliveryTimersRef.current.get(messageId);
    if (timer !== undefined) window.clearTimeout(timer);
    pendingDeliveryTimersRef.current.delete(messageId);
  }

  function clearDeliveryWatches() {
    for (const timer of pendingDeliveryTimersRef.current.values()) window.clearTimeout(timer);
    pendingDeliveryTimersRef.current.clear();
  }

  async function clearOnlyThisBrowser() {
    if (!peer) return;
    setShowClearDialog(false);
    setHistoryNotice("");
    try {
      await clearChatLocally(peer.id, connectionRef.current);
      setHistoryNotice(t("notice.clearedLocal"));
    } catch (reason) {
      setHistoryNotice(reason instanceof Error ? reason.message : t("notice.clearLocalFailed"));
    }
  }

  async function requestClearForEveryone() {
    if (!peer) return;
    setShowClearDialog(false);
    setHistoryNotice("");
    const connection = connectionRef.current;
    if (!connection || pendingClearRequestRef.current) {
      setHistoryNotice(t("notice.clearUnavailable"));
      return;
    }

    const id = crypto.randomUUID();
    pendingClearRequestRef.current = id;
    setPendingClearRequest(id);
    setHistoryNotice(t("notice.clearWaiting"));
    pendingClearTimerRef.current = window.setTimeout(() => {
      if (pendingClearRequestRef.current !== id) return;
      finishPendingClearRequest();
      setHistoryNotice(t("notice.clearTimeout"));
    }, 20_000);
    try {
      await connection.send({ kind: "clear-chat-request", id });
    } catch (reason) {
      finishPendingClearRequest();
      setHistoryNotice(reason instanceof Error ? reason.message : t("notice.clearRequestFailed"));
    }
  }

  async function acceptIncomingClearRequest() {
    const id = incomingClearRequestRef.current;
    const currentPeer = peerRef.current;
    const connection = connectionRef.current;
    if (!id || !currentPeer || !connection) return;
    incomingClearRequestRef.current = null;
    setIncomingClearRequest(null);
    try {
      await clearChatLocally(currentPeer.id, connection);
      await connection.send({ kind: "clear-chat-response", id, accepted: true });
      setHistoryNotice(t("notice.clearedEveryone"));
    } catch (reason) {
      setHistoryNotice(reason instanceof Error ? reason.message : t("notice.clearFinishFailed"));
    }
  }

  async function declineIncomingClearRequest() {
    const id = incomingClearRequestRef.current;
    const connection = connectionRef.current;
    if (!id) return;
    incomingClearRequestRef.current = null;
    setIncomingClearRequest(null);
    try {
      if (connection) await connection.send({ kind: "clear-chat-response", id, accepted: false });
      setHistoryNotice(t("notice.clearRejected"));
    } catch (reason) {
      setHistoryNotice(reason instanceof Error ? reason.message : t("notice.clearRejectFailed"));
    }
  }

  async function clearChatLocally(
    chatId: string,
    connection: DirectTalkConnection | null,
  ) {
    chatGenerationRef.current += 1;
    await cancelAllPhotoTransfers(connection);
    clearPendingDeletes();
    clearDeliveryWatches();
    setMessageMenuId(null);
    setDeleteConfirmation(null);
    setPhotoError("");

    await db.transaction("rw", db.messages, db.attachments, async () => {
      await db.attachments.where("chatId").equals(chatId).delete();
      await db.messages.where("chatId").equals(chatId).delete();
    });
    setMessages([]);
    setAttachments({});
  }

  async function cancelAllPhotoTransfers(connection: DirectTalkConnection | null) {
    const transferIds = new Set([
      ...outgoingPhotosRef.current.keys(),
      ...incomingPhotosRef.current.keys(),
    ]);
    const offers = [...incomingPhotoOffersRef.current.values()];
    for (const id of transferIds) cancelledPhotosRef.current.add(id);
    outgoingPhotosRef.current.clear();
    sendingPhotosRef.current.clear();
    incomingPhotosRef.current.clear();
    incomingPhotoOffersRef.current.clear();
    setIncomingPhotoOffers([]);
    setPhotoTransfers({});

    if (!connection) return;
    for (const id of transferIds) {
      try {
        await connection.send({ kind: "photo-cancel", id, reason: "cancelled" });
      } catch {
        break;
      }
    }
    for (const offer of offers) {
      try {
        await connection.send({ kind: "photo-response", id: offer.id, accepted: false });
      } catch {
        break;
      }
    }
  }

  function finishPendingClearRequest() {
    if (pendingClearTimerRef.current !== null) window.clearTimeout(pendingClearTimerRef.current);
    pendingClearTimerRef.current = null;
    pendingClearRequestRef.current = null;
    setPendingClearRequest(null);
  }

  async function verifyContact() {
    if (!contact) return;
    await db.contacts.update(contact.id, { verified: true });
    setContact({ ...contact, verified: true });
  }

  function insertEmoji(emoji: string) {
    const textarea = composerRef.current;
    const start = textarea?.selectionStart ?? draft.length;
    const end = textarea?.selectionEnd ?? draft.length;
    const nextDraft = `${draft.slice(0, start)}${emoji}${draft.slice(end)}`;
    if (nextDraft.length > 4_000) return;
    setDraft(nextDraft);
    window.requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  }

  function handleLocalError(reason: unknown) {
    logDiagnostic("storage", "local-operation-failed", { reason: safeErrorText(reason) }, "error");
    setError(reason instanceof Error ? reason.message : t("error.storage"));
  }

  async function copyInvitation() {
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_800);
    } catch (reason) {
      logDiagnostic("invite", "clipboard-copy-failed", { reason: safeErrorText(reason) }, "warn");
      setError(t("error.clipboard"));
    }
  }

  function toggleSounds() {
    const next = !soundsEnabled;
    appSounds.setEnabled(next);
    writeSoundEnabled(next);
    setSoundsEnabled(next);
    if (next) void appSounds.play("startup");
  }

  function reset() {
    logDiagnostic("app", "returned-home");
    connectionGenerationRef.current += 1;
    chatGenerationRef.current += 1;
    for (const id of outgoingPhotosRef.current.keys()) cancelledPhotosRef.current.add(id);
    for (const id of incomingPhotosRef.current.keys()) cancelledPhotosRef.current.add(id);
    connectionRef.current?.close();
    connectionRef.current = null;
    peerRef.current = null;
    clearResumableSession();
    setResumableSession(null);
    clearInvitationFromAddressBar();
    setPeer(null);
    setContact(null);
    setMessages([]);
    setAttachments({});
    setIncomingPhotoOffers([]);
    setPhotoTransfers({});
    setPhotoError("");
    outgoingPhotosRef.current.clear();
    sendingPhotosRef.current.clear();
    incomingPhotosRef.current.clear();
    incomingPhotoOffersRef.current.clear();
    clearPendingDeletes();
    clearDeliveryWatches();
    finishPendingClearRequest();
    incomingClearRequestRef.current = null;
    setIncomingClearRequest(null);
    setMessageMenuId(null);
    setDeleteConfirmation(null);
    setShowClearDialog(false);
    setHistoryNotice("");
    setDraft("");
    setInvitation(null);
    setIncomingInvite(null);
    setInviteLink("");
    setError("");
    setErrorDiagnosticId(null);
    setShowEmoji(false);
    setShowSecurity(false);
    setConnectionState("closed");
    setScreen("home");
  }

  const activePeer = peer;
  const activeContact = contact;
  const activeMessages = messages;
  const activeAttachments = attachments;
  const incomingTransfers = Object.values(photoTransfers).filter(
    (transfer) => transfer.direction === "incoming" && transfer.status !== "complete",
  );
  const isConversationOpen = screen === "chat";
  const connectionReady = connectionState === "secure";
  const chatMarkState: OxalisState = connectionReady ? "online" : "connecting";
  const logoState: OxalisState = isConversationOpen
    ? chatMarkState
    : screen === "loading" || screen === "waiting"
      ? "connecting"
      : "offline";

  return (
    <>
      {showSplash && <SplashScreen />}
      <main className={`app-shell ${isConversationOpen ? "chat-open" : ""}`} data-theme={theme}>
      <header className="topbar">
        <button className="brand" type="button" onClick={screen === "home" ? undefined : reset} aria-label={t("top.home")}>
          <OxalisMark state={logoState} />
          <span className="brand-copy"><strong>DirectTalk</strong><small>peer-to-peer messenger</small></span>
        </button>
        <div className="top-actions">
          <span className="privacy-note"><i /> {t("top.private")}</span>
          <label className="language-picker">
            <span aria-hidden="true">文</span>
            <select
              value={languagePreference}
              onChange={(event) => setLanguagePreference(event.target.value as LanguagePreference)}
              aria-label={t("language.label")}
              title={t("language.label")}
            >
              <option value="auto">{t("language.auto")} · {language.toUpperCase()}</option>
              <option value="en">English</option>
              <option value="pl">Polski</option>
              <option value="ru">Русский</option>
              <option value="uk">Українська</option>
            </select>
          </label>
          <div className="theme-switcher">
            <button
              className="theme-trigger"
              type="button"
              onClick={() => setShowThemes((visible) => !visible)}
              aria-expanded={showThemes}
              aria-label={t("theme.choose")}
            >
              <span className={`theme-orb ${theme}`} />
              {t("theme.label")}
              <span aria-hidden="true">▾</span>
            </button>
            {showThemes && (
              <div className="theme-menu">
                <div className="menu-title">{t("theme.appearance")}</div>
                {themeOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={theme === option.id ? "selected" : ""}
                    onClick={() => {
                      setTheme(option.id);
                      setShowThemes(false);
                    }}
                  >
                    <span className="theme-preview">
                      <i style={{ background: option.colors[0] }} />
                      <i style={{ background: option.colors[1] }} />
                    </span>
                    {option.label}
                    {theme === option.id && <span className="menu-check">✓</span>}
                  </button>
                ))}
                <button className="sound-menu-button" data-sound-control type="button" onClick={toggleSounds} aria-pressed={soundsEnabled}>
                  <SpeakerIcon muted={!soundsEnabled} />
                  {soundsEnabled ? t("sound.on") : t("sound.off")}
                  <span className="menu-check">{soundsEnabled ? "✓" : "—"}</span>
                </button>
              </div>
            )}
          </div>
          <SoundToggle
            className="top-sound-trigger"
            enabled={soundsEnabled}
            onToggle={toggleSounds}
            label={soundsEnabled ? t("sound.disable") : t("sound.enable")}
          />
          <button
            className="diagnostics-trigger"
            type="button"
            onClick={() => setShowDiagnostics(true)}
            title={diagnosticsCopy[language].title}
            aria-label={diagnosticsCopy[language].title}
          >
            <span aria-hidden="true">i</span>
            <b>{diagnosticsCopy[language].button}</b>
          </button>
        </div>
      </header>

      {screen === "loading" && <StatusCard windowTitle={t("loading.window")} title={t("loading.title")} description={t("loading.description")} />}

      {screen === "home" && (
        <section className="card home-card y2k-window">
          <WindowTitlebar title={incomingInvite ? t("home.incomingWindow") : t("home.newWindow")} markState="offline" />
          <div className="home-body">
            <div className="welcome-mark offline"><i className="status-dot" aria-hidden="true" /><span>{t("peer.offline")}</span></div>
            <div className="eyebrow">{t("home.eyebrow")}</div>
            <h1>{incomingInvite ? t("home.invitedTitle") : t("home.greetingTitle")}</h1>
            <p className="lead">{t("home.lead")}</p>

            <form onSubmit={incomingInvite ? startJoiner : startCreator} className="start-form">
              <label htmlFor="display-name">{t("home.nameLabel")}</label>
              <div className="field-frame">
                <span aria-hidden="true">☺</span>
                <input
                  id="display-name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  maxLength={40}
                  autoComplete="nickname"
                  placeholder={t("home.namePlaceholder")}
                />
              </div>
              {error && <p className="inline-error">{localizeRuntimeMessage(language, error)}</p>}
              <button className="primary-button" type="submit">
                <span aria-hidden="true">{incomingInvite ? "↗" : "+"}</span>
                {incomingInvite ? t("home.connect") : t("home.create")}
              </button>
            </form>

            <div className="security-summary">
              <LockIcon />
              <div>
                <strong>{t("home.encryptedTitle")}</strong>
                <span>{t("home.encryptedDescription")}</span>
              </div>
            </div>
          </div>
          <div className="feature-strip" aria-label={t("home.features")}>
            <span><b>☺</b> {t("home.emoji")}</span>
            <span><b>✓</b> {t("home.statuses")}</span>
            <span><b>▧</b> {t("home.photos")}</span>
            <span className="app-version" title={`DirectTalk ${APP_VERSION}`}>v{APP_VERSION}</span>
          </div>
        </section>
      )}

      {screen === "waiting" && invitation && (
        <section className="card waiting-card y2k-window">
          <WindowTitlebar title={t("waiting.window")} markState="connecting" />
          <div className="waiting-body">
            <div className="pulse-lock"><LockIcon /></div>
            <div className="eyebrow">{t(stateLabelKeys[connectionState])}</div>
            <h1>{connectionState === "waiting-peer" || (connectionState === "waiting-reconnect" && inviteLink)
              ? t("waiting.invite")
              : connectionState === "reconnecting" || connectionState === "waiting-reconnect"
                ? t("waiting.restore")
                : t("waiting.channel")}</h1>

            {inviteLink && (connectionState === "waiting-peer" || connectionState === "waiting-reconnect") && (
              <div className="invite-layout">
                {qrCode && <img className="qr-code" src={qrCode} alt={t("waiting.qrAlt")} />}
                <div className="invite-details">
                  <label htmlFor="invite-link">{t("waiting.link")}</label>
                  <div className="invite-row">
                    <input id="invite-link" value={inviteLink} readOnly onFocus={(event) => event.currentTarget.select()} />
                    <button type="button" onClick={() => void copyInvitation()}>{copied ? t("common.copied") : t("common.copy")}</button>
                  </div>
                  <p className="quiet">{t("waiting.help")}</p>
                </div>
              </div>
            )}

            {connectionState !== "waiting-peer" && <div className="connection-steps"><span className="active" /><span className="active" /><span /></div>}
            <button className="text-button" type="button" onClick={reset}>{t("waiting.cancel")}</button>
          </div>
          <div className="window-statusbar"><span>● DirectTalk network</span><span>{t("waiting.encryption")}</span></div>
        </section>
      )}

      {isConversationOpen && activePeer && activeContact && (
        <section className="chat-card y2k-window">
          <WindowTitlebar
            title={`${activePeer.name} — ${t("chat.title")}`}
            onClose={reset}
            closeLabel={t("common.close")}
            markState={chatMarkState}
            extra={(
              <div className="chat-title-actions">
                <SoundToggle
                  className="chat-sound-trigger"
                  enabled={soundsEnabled}
                  onToggle={toggleSounds}
                  label={soundsEnabled ? t("sound.disable") : t("sound.enable")}
                />
                <label className="language-picker chat-language-picker">
                  <select
                    value={languagePreference}
                    onChange={(event) => setLanguagePreference(event.target.value as LanguagePreference)}
                    aria-label={t("language.label")}
                    title={t("language.label")}
                  >
                    <option value="auto">{t("language.auto")} · {language.toUpperCase()}</option>
                    <option value="en">EN</option>
                    <option value="pl">PL</option>
                    <option value="ru">RU</option>
                    <option value="uk">UK</option>
                  </select>
                </label>
              </div>
            )}
          />
          <input
            ref={photoInputRef}
            className="visually-hidden"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            onChange={(event) => void handlePhotoSelection(event)}
            disabled={!connectionReady}
            tabIndex={-1}
          />

          <nav className="chat-toolbar" aria-label={t("chat.tools")}>
            <button className="active" type="button"><span>▤</span>{t("chat.messages")}</button>
            <button type="button" onClick={() => photoInputRef.current?.click()} disabled={!connectionReady} title={t("chat.photoTooltip")}><span>▧</span>{t("chat.photo")}<small>{t("chat.upTo10")}</small></button>
            <button type="button" disabled title={t("chat.voiceTooltip")}><span>◉</span>{t("chat.voice")}<small>{t("chat.soon")}</small></button>
            <button type="button" disabled title={t("chat.callTooltip")}><span>☎</span>{t("chat.call")}<small>{t("chat.soon")}</small></button>
            <button type="button" onClick={() => setShowClearDialog(true)} disabled={Boolean(pendingClearRequest)} title={t("chat.clearTooltip")}><span>⌫</span>{t("chat.clear")}<small>{pendingClearRequest ? t("chat.waiting") : t("chat.history")}</small></button>
            <button className="security-tool" type="button" onClick={() => setShowSecurity(!showSecurity)}><span>◆</span>{t("chat.security")}</button>
          </nav>

          {!connectionReady && (
            <div className="reconnect-banner" role="status" aria-live="polite">
              <OxalisMark state="connecting" />
              <div><strong>{t("peer.reconnecting")}</strong><span>{t("chat.reconnecting")}</span></div>
            </div>
          )}

          {showSecurity && (
            <aside className="security-panel">
              <div>
                <span>{t("security.code")}</span>
                <code>{activePeer.securityCode}</code>
              </div>
              <p>{t("security.description")}</p>
              <details>
                <summary>{t("security.fingerprint")}</summary>
                <code>{activePeer.fingerprint}</code>
              </details>
              {!activeContact.verified && <button type="button" onClick={() => void verifyContact()}>{t("security.match")}</button>}
            </aside>
          )}

          <div className="chat-workspace">
            <div className="conversation-pane">
              <div className="message-list" ref={messageListRef} aria-live="polite">
                {connectionReady && <div className="session-notice"><LockIcon /> {t("session.secure")} · {formatTime(sessionStartedAtRef.current, language)}</div>}
                {incomingClearRequest && (
                  <section className="history-clear-request" role="alert">
                    <div><strong>{t("clearRequest.title", { name: activePeer.name })}</strong><span>{t("clearRequest.description")}</span></div>
                    <div>
                      <button type="button" onClick={() => void acceptIncomingClearRequest()}>{t("clearRequest.accept")}</button>
                      <button type="button" onClick={() => void declineIncomingClearRequest()}>{t("clearRequest.keep")}</button>
                    </div>
                  </section>
                )}
                {historyNotice && (
                  <div className="history-notice" role="status"><span>{localizeRuntimeMessage(language, historyNotice)}</span><button type="button" onClick={() => setHistoryNotice("")} aria-label={t("notice.close")}>×</button></div>
                )}
                {incomingPhotoOffers.map((offer) => (
                  <section className="photo-offer" key={offer.id}>
                    <div className="photo-offer-icon" aria-hidden="true">▧</div>
                    <div>
                      <strong>{t("photo.offerTitle", { name: activePeer.name })}</strong>
                      <span>{offer.name} · {formatFileSize(offer.size)}</span>
                      <small>{t("photo.offerDescription")}</small>
                    </div>
                    <div className="photo-offer-actions">
                      <button type="button" onClick={() => void acceptPhotoOffer(offer)}>{t("common.accept")}</button>
                      <button type="button" onClick={() => void declinePhotoOffer(offer)}>{t("common.decline")}</button>
                    </div>
                  </section>
                ))}
                {incomingTransfers.map((transfer) => (
                  <section className={`photo-transfer-card ${transfer.status}`} key={transfer.id}>
                    <div><strong>{transfer.name}</strong><span>{photoTransferText(transfer, language)}</span></div>
                    <div className="photo-progress" aria-label={t("photo.progressReceived", { percent: Math.round(transfer.progress * 100) })}><i style={{ width: `${transfer.progress * 100}%` }} /></div>
                    {(transfer.status === "receiving") && <button type="button" onClick={() => void cancelPhotoTransfer(transfer.id)}>{t("common.cancel")}</button>}
                  </section>
                ))}
                {activeMessages.length === 0 && incomingPhotoOffers.length === 0 && incomingTransfers.length === 0 && (
                  <div className="empty-chat">
                    <OxalisMark state={chatMarkState} />
                    <strong>{connectionReady ? t("empty.online", { name: activePeer.name }) : t("peer.reconnecting")}</strong>
                    <span>{connectionReady ? t("empty.prompt") : t("chat.reconnecting")}</span>
                  </div>
                )}
                {activeMessages.map((message) => (
                  <article key={message.id} className={`message ${message.sender === "me" ? "mine" : "theirs"}`}>
                    <header>
                      <strong>{message.sender === "me" ? displayName || t("common.you") : activePeer.name}</strong>
                      <time dateTime={new Date(message.createdAt).toISOString()}>({formatTime(message.createdAt, language)})</time>
                      {message.sender === "me" && <span title={pendingDeleteIds.has(message.id) ? t("message.pendingDeletion") : statusText(message.status, language)}>{pendingDeleteIds.has(message.id) ? "…" : statusMark(message.status)}</span>}
                      <button
                        className="message-actions-trigger"
                        type="button"
                        onClick={() => setMessageMenuId((current) => current === message.id ? null : message.id)}
                        aria-expanded={messageMenuId === message.id}
                        aria-label={t("message.actions")}
                        disabled={pendingDeleteIds.has(message.id)}
                      >•••</button>
                    </header>
                    {message.kind === "photo" && message.attachmentId ? (
                      <PhotoMessage
                        attachment={activeAttachments[message.attachmentId]}
                        transfer={photoTransfers[message.id]}
                        onCancel={() => void cancelPhotoTransfer(message.id)}
                        language={language}
                      />
                    ) : <p>{message.text}</p>}
                    {messageMenuId === message.id && (
                      <div className="message-actions-menu" role="menu">
                        <button type="button" role="menuitem" onClick={() => {
                          setMessageMenuId(null);
                          setDeleteConfirmation({ messageId: message.id, scope: "local" });
                        }}>{t("message.deleteLocal")}</button>
                        {message.sender === "me" && (
                          <button type="button" role="menuitem" disabled={!connectionReady} onClick={() => {
                            setMessageMenuId(null);
                            setDeleteConfirmation({ messageId: message.id, scope: "everyone" });
                          }}>{t("message.deleteEveryone")}</button>
                        )}
                      </div>
                    )}
                  </article>
                ))}
              </div>

              <form className="composer" onSubmit={(event) => void sendMessage(event)}>
                <textarea
                  ref={composerRef}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  maxLength={4_000}
                  rows={3}
                  placeholder={t("message.placeholder", { name: activePeer.name })}
                  aria-label={t("message.label")}
                />

                {showEmoji && (
                  <div className="emoji-picker" aria-label={t("emoji.label")}>
                    <div className="emoji-picker-title"><span>{t("emoji.classic")}</span><button type="button" onClick={() => setShowEmoji(false)} aria-label={t("common.close")}>×</button></div>
                    <div className="emoji-grid">
                      {classicEmoji.map((emoji) => (
                        <button key={emoji} type="button" onClick={() => insertEmoji(emoji)} aria-label={t("emoji.add", { emoji })}>{emoji}</button>
                      ))}
                    </div>
                  </div>
                )}

                {photoError && <div className="photo-error" role="alert">{localizeRuntimeMessage(language, photoError)}</div>}

                <div className="composer-toolbar">
                  <div className="format-actions">
                    <button type="button" disabled title={t("composer.formatTooltip")}><b>T</b></button>
                    <button
                      className={showEmoji ? "active" : ""}
                      type="button"
                      onClick={() => setShowEmoji((visible) => !visible)}
                      aria-expanded={showEmoji}
                      title={t("emoji.label")}
                    >☺</button>
                    <button type="button" onClick={() => photoInputRef.current?.click()} disabled={!connectionReady} title={t("composer.photoTooltip")}>📎</button>
                    <button type="button" disabled title={t("composer.voiceTooltip")}>🎙</button>
                  </div>
                  <span className="draft-counter">{draft.length}/4000</span>
                  <button className="send-button" type="submit" disabled={!draft.trim() || !connectionReady}>{t("common.send")}</button>
                </div>
              </form>
            </div>

            <aside className="peer-sidebar">
              <div className="peer-avatar" aria-hidden="true">{activePeer.name.slice(0, 1).toUpperCase()}</div>
              <div className="peer-online"><OxalisMark state={chatMarkState} /><strong>{activePeer.name}</strong></div>
              <span className={`presence ${connectionReady ? "" : "reconnecting"}`}>● {connectionReady ? t("peer.online") : t("peer.reconnecting")}</span>
              <div className="peer-divider" />
              <button type="button" className={activeContact.verified ? "verified" : ""} onClick={() => setShowSecurity(!showSecurity)}>
                <LockIcon />
                {activeContact.verified ? t("peer.verified") : t("peer.compare")}
              </button>
              <p>{t("peer.directDescription")}</p>
            </aside>
          </div>

          {deleteConfirmation && (
            <div className="dialog-backdrop" role="presentation">
              <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title">
                <WindowTitlebar title={t("delete.window")} onClose={() => setDeleteConfirmation(null)} closeLabel={t("common.close")} markState="online" />
                <div className="confirm-dialog-body">
                  <div className="confirm-dialog-icon">!</div>
                  <div>
                    <h2 id="delete-dialog-title">{t("delete.title")}</h2>
                    <p>{deleteConfirmation.scope === "everyone"
                      ? t("delete.everyoneDescription")
                      : t("delete.localDescription")}</p>
                  </div>
                </div>
                <div className="confirm-dialog-actions">
                  <button type="button" onClick={() => setDeleteConfirmation(null)}>{t("common.cancel")}</button>
                  <button className="danger-button" type="button" onClick={() => void confirmMessageDeletion()}>{t("common.delete")}</button>
                </div>
              </section>
            </div>
          )}

          {showClearDialog && (
            <div className="dialog-backdrop" role="presentation">
              <section className="confirm-dialog clear-dialog" role="dialog" aria-modal="true" aria-labelledby="clear-dialog-title">
                <WindowTitlebar title={t("clear.window")} onClose={() => setShowClearDialog(false)} closeLabel={t("common.close")} markState="online" />
                <div className="confirm-dialog-body">
                  <div className="confirm-dialog-icon">!</div>
                  <div>
                    <h2 id="clear-dialog-title">{t("clear.title")}</h2>
                    <p>{t("clear.description")}</p>
                  </div>
                </div>
                <div className="clear-dialog-options">
                  <button type="button" onClick={() => void clearOnlyThisBrowser()}><strong>{t("clear.local")}</strong><span>{t("clear.localDescription")}</span></button>
                  <button type="button" onClick={() => void requestClearForEveryone()} disabled={!connectionReady}><strong>{t("clear.everyone")}</strong><span>{t("clear.everyoneDescription")}</span></button>
                </div>
                <div className="confirm-dialog-actions"><button type="button" onClick={() => setShowClearDialog(false)}>{t("common.cancel")}</button></div>
              </section>
            </div>
          )}

          <div className="window-statusbar"><span>● {activePeer.name}: {connectionReady ? t("peer.online") : t("peer.reconnecting")}</span><span>{t("status.messages", { count: activeMessages.length })}</span><span>{connectionReady ? "WebRTC · E2EE" : t("state.reconnecting")}</span></div>
        </section>
      )}

      {screen === "error" && (
        <section className="card error-card y2k-window">
          <WindowTitlebar title={t("error.window")} markState="offline" />
          <div className="error-body">
            <div className="error-icon">!</div>
            <h1>{t("error.title")}</h1>
            <p>{localizeRuntimeMessage(language, error)}</p>
            {errorDiagnosticId !== null && <code className="error-diagnostic-id">Diagnostic ID #{errorDiagnosticId}</code>}
            <button className="diagnostics-error-button" type="button" onClick={() => setShowDiagnostics(true)}>{diagnosticsCopy[language].button}</button>
            <button className="primary-button" type="button" onClick={reset}>{t("error.back")}</button>
          </div>
        </section>
      )}

        {showDiagnostics && <DiagnosticsPanel language={language} markState={logoState} onClose={() => setShowDiagnostics(false)} />}

        <footer className="page-footer"><span>DirectTalk {APP_VERSION}</span><span>{t("footer.history")}</span></footer>
      </main>
    </>
  );
}

function SplashScreen() {
  const [markState, setMarkState] = useState<OxalisState>("offline");

  useEffect(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(() => setMarkState("online"), reduceMotion ? 0 : 280);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="splash-screen started" aria-hidden="true">
      <div className="splash-glow" />
      <OxalisMark className="splash-logo" state={markState} />
      <span className="splash-name">DirectTalk</span>
    </div>
  );
}

function DiagnosticsPanel({
  language,
  markState,
  onClose,
}: {
  language: Language;
  markState: OxalisState;
  onClose: () => void;
}) {
  const copy = diagnosticsCopy[language];
  const [, setRevision] = useState(0);
  const [copied, setCopied] = useState(false);
  const reportRef = useRef<HTMLTextAreaElement | null>(null);
  const report = formatDiagnosticReport();
  const count = getDiagnosticEntries().length;

  useEffect(() => subscribeDiagnostics(() => setRevision((current) => current + 1)), []);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function copyReport() {
    try {
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(report);
        } catch (error) {
          if (!copyReportFromTextarea()) throw error;
        }
      } else if (!copyReportFromTextarea()) {
        throw new Error("Clipboard API is unavailable");
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_800);
    } catch (error) {
      logDiagnostic("diagnostics", "copy-failed", { reason: safeErrorText(error) }, "warn");
    }
  }

  function copyReportFromTextarea(): boolean {
    const textarea = reportRef.current;
    if (!textarea) return false;
    textarea.focus();
    textarea.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    }
  }

  async function shareReport() {
    if (!navigator.share) return;
    try {
      await navigator.share({ title: "DirectTalk diagnostics", text: report });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        logDiagnostic("diagnostics", "share-failed", { reason: safeErrorText(error) }, "warn");
      }
    }
  }

  return (
    <div className="diagnostics-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="diagnostics-panel y2k-window" role="dialog" aria-modal="true" aria-labelledby="diagnostics-title">
        <WindowTitlebar title={copy.title} onClose={onClose} closeLabel={copy.close} markState={markState} />
        <div className="diagnostics-body">
          <div className="diagnostics-heading">
            <div><h2 id="diagnostics-title">{copy.title}</h2><p>{copy.description}</p></div>
            <span>{count}</span>
          </div>
          <textarea ref={reportRef} value={report} readOnly spellCheck={false} aria-label={copy.title} onFocus={(event) => event.currentTarget.select()} />
          <div className="diagnostics-actions">
            <button type="button" onClick={() => void copyReport()}>{copied ? copy.copied : copy.copy}</button>
            {Boolean(navigator.share) && <button type="button" onClick={() => void shareReport()}>{copy.share}</button>}
            <button type="button" onClick={clearDiagnostics}>{copy.clear}</button>
            <button className="primary-button" type="button" onClick={onClose}>{copy.close}</button>
          </div>
        </div>
      </section>
    </div>
  );
}

function PhotoMessage({
  attachment,
  transfer,
  onCancel,
  language,
}: {
  attachment?: StoredAttachment;
  transfer?: PhotoTransfer;
  onCancel: () => void;
  language: Language;
}) {
  const [url, setUrl] = useState("");

  useEffect(() => {
    if (!attachment) {
      setUrl("");
      return;
    }
    const objectUrl = URL.createObjectURL(attachment.blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [attachment]);

  if (!attachment) return <div className="photo-unavailable">{translate(language, "photo.unavailable")}</div>;
  const canCancel = transfer && (transfer.status === "preparing" || transfer.status === "waiting" || transfer.status === "transferring");

  return (
    <div className="photo-message">
      {url && <a className="photo-preview" href={url} target="_blank" rel="noreferrer"><img src={url} alt={attachment.name} /></a>}
      <div className="photo-meta">
        <div><strong>{attachment.name}</strong><span>{formatFileSize(attachment.size)}</span></div>
        {url && <a href={url} download={attachment.name}>{translate(language, "common.download")}</a>}
      </div>
      {transfer && transfer.status !== "complete" && (
        <div className={`photo-message-transfer ${transfer.status}`}>
          <span>{photoTransferText(transfer, language)}</span>
          <div className="photo-progress"><i style={{ width: `${transfer.progress * 100}%` }} /></div>
          {canCancel && <button type="button" onClick={onCancel}>{translate(language, "common.cancel")}</button>}
        </div>
      )}
    </div>
  );
}

function StatusCard({ windowTitle, title, description }: { windowTitle: string; title: string; description: string }) {
  return (
    <section className="card status-card y2k-window">
      <WindowTitlebar title={windowTitle} markState="connecting" />
      <div className="status-body">
        <div className="spinner" />
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
    </section>
  );
}

function WindowTitlebar({
  title,
  onClose,
  closeLabel = "Close",
  extra,
  markState = "offline",
}: {
  title: string;
  onClose?: () => void;
  closeLabel?: string;
  extra?: ReactNode;
  markState?: OxalisState;
}) {
  return (
    <header className="window-titlebar">
      <OxalisMark state={markState} />
      <strong>{title}</strong>
      {extra}
      <div className="window-controls" aria-hidden={!onClose}>
        <span>—</span>
        <span>□</span>
        {onClose ? <button type="button" onClick={onClose} aria-label={closeLabel}>×</button> : <span>×</span>}
      </div>
    </header>
  );
}

function SoundToggle({
  enabled,
  onToggle,
  label,
  className = "",
}: {
  enabled: boolean;
  onToggle: () => void;
  label: string;
  className?: string;
}) {
  return (
    <button
      className={`sound-trigger ${enabled ? "enabled" : "muted"} ${className}`.trim()}
      data-sound-control
      type="button"
      onClick={onToggle}
      aria-label={label}
      aria-pressed={enabled}
      title={label}
    >
      <SpeakerIcon muted={!enabled} />
    </button>
  );
}

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" />
      {!muted && <path d="M16 8.2c1 .9 1.5 2.2 1.5 3.8S17 14.9 16 15.8m2.6-10.2c1.7 1.6 2.7 3.7 2.7 6.4s-1 4.8-2.7 6.4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />}
      {muted && <path d="m16.2 8 5.2 8m0-8-5.2 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7.5 10V7.5a4.5 4.5 0 0 1 9 0V10m-11 0h13v10h-13z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

async function acknowledgeMessage(connection: DirectTalkConnection, messageId: string, status: "delivered" | "read") {
  await connection.send({ kind: "ack", messageId, status });
  logDiagnostic("chat", "ack-queued", { status });
}

function upsertMessage(messages: StoredMessage[], message: StoredMessage): StoredMessage[] {
  const withoutExisting = messages.filter((item) => item.id !== message.id);
  return [...withoutExisting, message].sort((left, right) => left.createdAt - right.createdAt);
}

function mergeStoredMessages(history: StoredMessage[], current: StoredMessage[]): StoredMessage[] {
  const merged = new Map(history.map((message) => [message.id, message]));
  for (const message of current) merged.set(message.id, message);
  return [...merged.values()].sort((left, right) => left.createdAt - right.createdAt);
}

function indexAttachments(items: StoredAttachment[]): Record<string, StoredAttachment> {
  return Object.fromEntries(items.map((attachment) => [attachment.id, attachment]));
}

function removeMessageAttachments(
  attachments: Record<string, StoredAttachment>,
  messageId: string,
): Record<string, StoredAttachment> {
  return Object.fromEntries(Object.entries(attachments).filter(([, attachment]) => attachment.messageId !== messageId));
}

async function ensureImageDecodes(blob: Blob, language: Language): Promise<void> {
  if ("createImageBitmap" in window) {
    const bitmap = await createImageBitmap(blob);
    try {
      if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width > 16_384 || bitmap.height > 16_384 || bitmap.width * bitmap.height > 64_000_000) {
        throw new Error(translate(language, "error.photoResolution"));
      }
    } finally {
      bitmap.close();
    }
    return;
  }

  const url = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        if (image.naturalWidth < 1 || image.naturalHeight < 1 || image.naturalWidth > 16_384 || image.naturalHeight > 16_384 || image.naturalWidth * image.naturalHeight > 64_000_000) {
          reject(new Error(translate(language, "error.photoResolution")));
        } else resolve();
      };
      image.onerror = () => reject(new Error(translate(language, "error.photoDecode")));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function photoTransferText(transfer: PhotoTransfer, language: Language): string {
  if (transfer.status === "preparing") return translate(language, "photo.preparing");
  if (transfer.status === "waiting") return translate(language, "photo.waiting");
  if (transfer.status === "transferring") return translate(language, "photo.sent", { percent: Math.round(transfer.progress * 100) });
  if (transfer.status === "receiving") return translate(language, "photo.received", { percent: Math.round(transfer.progress * 100) });
  if (transfer.status === "complete") return translate(language, "photo.complete");
  if (transfer.status === "declined") return translate(language, "photo.declined");
  if (transfer.status === "cancelled") return translate(language, "photo.cancelled");
  return transfer.error ? localizeRuntimeMessage(language, transfer.error) : translate(language, "photo.failed");
}

function photoCancelText(reason: PhotoCancelReason, language: Language): string {
  return {
    cancelled: translate(language, "photo.peerCancelled"),
    invalid: translate(language, "photo.invalid"),
    "hash-mismatch": translate(language, "photo.hashMismatch"),
    unsupported: translate(language, "photo.unsupported"),
    "transfer-failed": translate(language, "photo.transferFailed"),
  }[reason];
}

function readLocalName(): string {
  try {
    return localStorage.getItem("directtalk.displayName") ?? "";
  } catch {
    return "";
  }
}

function readTheme(): ThemeId {
  try {
    const stored = localStorage.getItem("directtalk.theme");
    if (stored === "lime" || stored === "aqua" || stored === "midnight") return stored;
  } catch {
    // Fall back to the classic theme.
  }
  return "lime";
}

function formatTime(timestamp: number, language: Language): string {
  return new Intl.DateTimeFormat(languageLocale[language], { hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

function statusMark(status: StoredMessage["status"]): string {
  if (status === "sending") return "·";
  if (status === "failed") return "!";
  if (status === "delivered") return "✓";
  return "✓✓";
}

function statusText(status: StoredMessage["status"], language: Language): string {
  const keys: Record<StoredMessage["status"], TranslationKey> = {
    sending: "status.sending",
    delivered: "status.delivered",
    read: "status.read",
    failed: "status.failed",
  };
  return translate(language, keys[status]);
}
