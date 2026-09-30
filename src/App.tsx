import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import QRCode from "qrcode";
import { OxalisMark, type OxalisState } from "./components/OxalisMark";
import { ChatListCard, type ChatListCopy } from "./components/ChatListCard";
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
  hideChatLocally,
  loadAttachments,
  loadChatSummaries,
  loadMessages,
  type StoredAttachment,
  type StoredChatSummary,
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
  parseReconnectCapability,
  reconnectInvitation,
  type ReconnectCapability,
} from "./lib/reconnect";
import {
  clearResumableIntent,
  clearResumableSession,
  readResumableSession,
  updateResumableReconnectCapability,
  updateResumablePeerIdentity,
  writeResumableSession,
} from "./lib/sessionResume";

type Screen = "loading" | "chats" | "home" | "waiting" | "chat" | "error";
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

interface ClearChatOperation {
  id: string;
  removeConversation: boolean;
}

interface PendingConversationRemoval {
  chatId: string | null;
  requestId: string;
}

interface ChatHubCopy extends ChatListCopy {
  window: string;
  localOnly: string;
  listStatus: string;
  deleteWindow: string;
  deleteTitle: string;
  deleteDescription: string;
  deleteLocal: string;
  deleteLocalDescription: string;
  deleteBoth: string;
  deleteBothDescription: string;
  deletedLocal: string;
  deletedBoth: string;
  deletedBothLegacy: string;
  deletedHereOnly: string;
  deleteFailed: string;
  legacyReconnectNotice: string;
  savedReconnectNotice: string;
  reconnectDeleteNotice: string;
  waitingRemovalAck: string;
  incomingDeleteTitle: string;
  incomingDeleteDescription: string;
  offlineTitle: string;
  offlineDescription: string;
  offlineSecurity: string;
  offlinePresence: string;
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

const chatHubCopy: Record<Language, ChatHubCopy> = {
  en: {
    window: "DirectTalk — chats", heading: "Your chats", newChat: "+ New chat",
    emptyTitle: "No saved chats yet", emptyDescription: "Create a private chat, then it will appear here on this device.",
    verified: "Verified device", photo: "Photo", noMessages: "No messages yet", messages: "messages", unread: "unread",
    open: "Open history", reconnect: "Reconnect", delete: "Delete", localOnly: "Stored only on this device", listStatus: "local chat list",
    deleteWindow: "DirectTalk — delete chat", deleteTitle: "Delete this chat?", deleteDescription: "Choose where to request deletion. This action cannot be undone.",
    deleteLocal: "Delete on this device", deleteLocalDescription: "Messages and photos disappear here; the verified device identity is kept.",
    deleteBoth: "Request deletion from both", deleteBothDescription: "Connect to the same saved chat. Its owner must confirm the request; an older chat may need one final secure link.",
    deletedLocal: "The chat was deleted from this device.", deletedBoth: "Both participants confirmed deletion of the chat.",
    deletedBothLegacy: "Both histories were cleared. The other device uses an older version, so an empty chat entry may remain there.", deleteFailed: "Could not delete the saved chat.",
    deletedHereOnly: "The chat was deleted here, but the other device did not send final confirmation.",
    legacyReconnectNotice: "This chat predates saved reconnect keys. Share this final one-time link; future reconnects will not need a QR code.",
    savedReconnectNotice: "Waiting for the same saved chat on the other device. No new link or QR code is needed.",
    reconnectDeleteNotice: "Waiting for the same saved chat on the other device. The deletion request will be sent after it connects.",
    waitingRemovalAck: "Deleted on this device. Waiting for the other device to confirm completion…",
    incomingDeleteTitle: "{name} asks to delete this chat on both devices",
    incomingDeleteDescription: "Messages, photos and this chat entry will be deleted from this browser. The trusted device identity will remain.",
    offlineTitle: "Local history", offlineDescription: "This device is not connected. Use Reconnect to continue with the same saved chat.",
    offlineSecurity: "The session code is available only during a live secure connection.", offlinePresence: "Offline · local history",
  },
  pl: {
    window: "DirectTalk — czaty", heading: "Twoje czaty", newChat: "+ Nowy czat",
    emptyTitle: "Brak zapisanych czatów", emptyDescription: "Utwórz prywatny czat, a pojawi się tutaj na tym urządzeniu.",
    verified: "Zweryfikowane urządzenie", photo: "Zdjęcie", noMessages: "Brak wiadomości", messages: "wiad.", unread: "nieprzeczytane",
    open: "Otwórz historię", reconnect: "Połącz ponownie", delete: "Usuń", localOnly: "Tylko na tym urządzeniu", listStatus: "lokalna lista czatów",
    deleteWindow: "DirectTalk — usuń czat", deleteTitle: "Usunąć ten czat?", deleteDescription: "Wybierz zakres żądania. Tej operacji nie można cofnąć.",
    deleteLocal: "Usuń na tym urządzeniu", deleteLocalDescription: "Wiadomości i zdjęcia znikną tutaj; tożsamość zaufanego urządzenia zostanie zachowana.",
    deleteBoth: "Poproś o usunięcie u obu", deleteBothDescription: "Połącz ten sam zapisany czat. Właściciel drugiego urządzenia musi potwierdzić; starszy czat może wymagać ostatniego bezpiecznego linku.",
    deletedLocal: "Czat usunięto z tego urządzenia.", deletedBoth: "Obie osoby potwierdziły usunięcie czatu.",
    deletedBothLegacy: "Obie historie wyczyszczono. Drugie urządzenie ma starszą wersję, więc może pozostać tam pusty wpis czatu.", deleteFailed: "Nie udało się usunąć zapisanego czatu.",
    deletedHereOnly: "Czat usunięto tutaj, ale drugie urządzenie nie wysłało końcowego potwierdzenia.",
    legacyReconnectNotice: "Ten czat powstał przed zapisywaniem kluczy ponownego połączenia. Udostępnij ten ostatni link jednorazowy; kolejne połączenia nie będą wymagać kodu QR.",
    savedReconnectNotice: "Czekamy na ten sam zapisany czat na drugim urządzeniu. Nowy link ani kod QR nie są potrzebne.",
    reconnectDeleteNotice: "Czekamy na ten sam zapisany czat na drugim urządzeniu. Żądanie usunięcia zostanie wysłane po połączeniu.",
    waitingRemovalAck: "Usunięto na tym urządzeniu. Czekamy na końcowe potwierdzenie drugiego urządzenia…",
    incomingDeleteTitle: "{name} prosi o usunięcie czatu na obu urządzeniach",
    incomingDeleteDescription: "Wiadomości, zdjęcia i wpis czatu zostaną usunięte z tej przeglądarki. Tożsamość zaufanego urządzenia pozostanie.",
    offlineTitle: "Historia lokalna", offlineDescription: "Urządzenie nie jest połączone. Użyj ponownego łączenia z tym samym zapisanym czatem.",
    offlineSecurity: "Kod sesji jest dostępny tylko podczas aktywnego bezpiecznego połączenia.", offlinePresence: "Offline · historia lokalna",
  },
  ru: {
    window: "DirectTalk — чаты", heading: "Ваши чаты", newChat: "+ Новый чат",
    emptyTitle: "Сохранённых чатов пока нет", emptyDescription: "Создайте приватный чат — он появится здесь на этом устройстве.",
    verified: "Проверенное устройство", photo: "Фотография", noMessages: "Сообщений пока нет", messages: "сообщ.", unread: "непрочитанных",
    open: "Открыть историю", reconnect: "Подключиться", delete: "Удалить", localOnly: "Только на этом устройстве", listStatus: "локальный список чатов",
    deleteWindow: "DirectTalk — удаление чата", deleteTitle: "Удалить этот чат?", deleteDescription: "Выберите, где запросить удаление. Отменить действие нельзя.",
    deleteLocal: "Удалить на этом устройстве", deleteLocalDescription: "Сообщения и фото исчезнут здесь, но ключ проверенного устройства сохранится.",
    deleteBoth: "Запросить удаление у обоих", deleteBothDescription: "Подключитесь к тому же сохранённому чату. Владелец второго устройства должен подтвердить запрос; старому чату может понадобиться последняя защищённая ссылка.",
    deletedLocal: "Чат удалён с этого устройства.", deletedBoth: "Оба участника подтвердили удаление чата.",
    deletedBothLegacy: "История очищена у обоих. На втором устройстве старая версия, поэтому там может остаться пустая строка чата.", deleteFailed: "Не удалось удалить сохранённый чат.",
    deletedHereOnly: "Чат удалён здесь, но второе устройство не прислало финальное подтверждение.",
    legacyReconnectNotice: "Этот чат создан до сохранения ключей повторного подключения. Передайте эту последнюю одноразовую ссылку — дальше QR-код не понадобится.",
    savedReconnectNotice: "Ждём тот же сохранённый чат на втором устройстве. Новая ссылка и QR-код не нужны.",
    reconnectDeleteNotice: "Ждём тот же сохранённый чат на втором устройстве. Запрос удаления уйдёт после подключения.",
    waitingRemovalAck: "На этом устройстве чат удалён. Ждём финальное подтверждение второго устройства…",
    incomingDeleteTitle: "{name} просит удалить чат на обоих устройствах",
    incomingDeleteDescription: "Сообщения, фото и чат будут удалены из этого браузера. Ключ доверенного устройства сохранится.",
    offlineTitle: "Локальная история", offlineDescription: "Сейчас соединения нет. Нажмите «Подключиться», чтобы продолжить тот же сохранённый чат.",
    offlineSecurity: "Код сеанса доступен только во время активного защищённого соединения.", offlinePresence: "Офлайн · локальная история",
  },
  uk: {
    window: "DirectTalk — чати", heading: "Ваші чати", newChat: "+ Новий чат",
    emptyTitle: "Збережених чатів поки немає", emptyDescription: "Створіть приватний чат — він з’явиться тут на цьому пристрої.",
    verified: "Перевірений пристрій", photo: "Фотографія", noMessages: "Повідомлень поки немає", messages: "повід.", unread: "непрочитаних",
    open: "Відкрити історію", reconnect: "Підключитися", delete: "Видалити", localOnly: "Лише на цьому пристрої", listStatus: "локальний список чатів",
    deleteWindow: "DirectTalk — видалення чату", deleteTitle: "Видалити цей чат?", deleteDescription: "Оберіть, де запросити видалення. Цю дію не можна скасувати.",
    deleteLocal: "Видалити на цьому пристрої", deleteLocalDescription: "Повідомлення й фото зникнуть тут, але ключ перевіреного пристрою збережеться.",
    deleteBoth: "Запросити видалення в обох", deleteBothDescription: "Підключіться до того самого збереженого чату. Власник іншого пристрою має підтвердити; старому чату може знадобитися останнє захищене посилання.",
    deletedLocal: "Чат видалено з цього пристрою.", deletedBoth: "Обидва учасники підтвердили видалення чату.",
    deletedBothLegacy: "Історію очищено в обох. На іншому пристрої стара версія, тому там може лишитися порожній запис чату.", deleteFailed: "Не вдалося видалити збережений чат.",
    deletedHereOnly: "Чат видалено тут, але інший пристрій не надіслав фінального підтвердження.",
    legacyReconnectNotice: "Цей чат створено до збереження ключів повторного підключення. Передайте це останнє одноразове посилання — надалі QR-код не знадобиться.",
    savedReconnectNotice: "Чекаємо на той самий збережений чат на іншому пристрої. Нове посилання та QR-код не потрібні.",
    reconnectDeleteNotice: "Чекаємо на той самий збережений чат на іншому пристрої. Запит на видалення надійде після підключення.",
    waitingRemovalAck: "На цьому пристрої чат видалено. Чекаємо фінального підтвердження іншого пристрою…",
    incomingDeleteTitle: "{name} просить видалити чат на обох пристроях",
    incomingDeleteDescription: "Повідомлення, фото й чат буде видалено з цього браузера. Ключ довіреного пристрою збережеться.",
    offlineTitle: "Локальна історія", offlineDescription: "З’єднання немає. Натисніть «Підключитися», щоб продовжити той самий збережений чат.",
    offlineSecurity: "Код сеансу доступний лише під час активного захищеного з’єднання.", offlinePresence: "Офлайн · локальна історія",
  },
};

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
  const [chatSummaries, setChatSummaries] = useState<StoredChatSummary[]>([]);
  const [chatListBusyId, setChatListBusyId] = useState<string | null>(null);
  const [chatListNotice, setChatListNotice] = useState("");
  const [chatDeleteTarget, setChatDeleteTarget] = useState<StoredChatSummary | null>(null);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [attachments, setAttachments] = useState<Record<string, StoredAttachment>>({});
  const [incomingPhotoOffers, setIncomingPhotoOffers] = useState<PhotoOfferPayload[]>([]);
  const [photoTransfers, setPhotoTransfers] = useState<Record<string, PhotoTransfer>>({});
  const [photoError, setPhotoError] = useState("");
  const [messageMenuId, setMessageMenuId] = useState<string | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState<DeleteConfirmation | null>(null);
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(() => new Set());
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [incomingClearRequest, setIncomingClearRequest] = useState<ClearChatOperation | null>(null);
  const [pendingClearRequest, setPendingClearRequest] = useState<ClearChatOperation | null>(null);
  const [awaitingRemovalAck, setAwaitingRemovalAck] = useState(false);
  const [historyNotice, setHistoryNotice] = useState("");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [showSecurity, setShowSecurity] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [showThemes, setShowThemes] = useState(false);
  const [showMobileSettings, setShowMobileSettings] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [errorDiagnosticId, setErrorDiagnosticId] = useState<number | null>(null);
  const [theme, setTheme] = useState<ThemeId>(() => readTheme());
  const [soundsEnabled, setSoundsEnabled] = useState(() => readSoundEnabled());
  const [showSplash, setShowSplash] = useState(true);
  const [resumableSession, setResumableSession] = useState(() => readResumableSession());
  const connectionRef = useRef<DirectTalkConnection | null>(null);
  const peerRef = useRef<SecurePeer | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const stickToMessageBottomRef = useRef(true);
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
  const incomingClearRequestRef = useRef<ClearChatOperation | null>(null);
  const pendingClearRequestRef = useRef<ClearChatOperation | null>(null);
  const pendingClearTimerRef = useRef<number | null>(null);
  const pendingConversationRemovalRef = useRef<PendingConversationRemoval | null>(null);
  const awaitingIncomingRemovalAckRef = useRef<ClearChatOperation | null>(null);
  const incomingRemovalAckTimerRef = useRef<number | null>(null);
  const connectionGenerationRef = useRef(0);
  const chatGenerationRef = useRef(0);
  const chatListOperationRef = useRef(0);
  const previousSecureRef = useRef(false);
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
    const syncViewport = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const height = Math.max(240, Math.round(viewport.height));
        document.documentElement.style.setProperty("--visual-viewport-height", `${height}px`);
      });
    };

    syncViewport();
    viewport.addEventListener("resize", syncViewport);
    viewport.addEventListener("scroll", syncViewport);
    window.addEventListener("orientationchange", syncViewport);
    window.addEventListener("pageshow", syncViewport);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", syncViewport);
      viewport.removeEventListener("scroll", syncViewport);
      window.removeEventListener("orientationchange", syncViewport);
      window.removeEventListener("pageshow", syncViewport);
      document.documentElement.style.removeProperty("--visual-viewport-height");
    };
  }, []);

  useEffect(() => {
    const closeFloatingMenus = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(".theme-switcher")) setShowThemes(false);
      if (!target?.closest(".mobile-settings")) setShowMobileSettings(false);
      if (!target?.closest(".message-actions-trigger, .message-actions-menu")) setMessageMenuId(null);
    };
    const closeFloatingMenusWithKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setShowThemes(false);
      setShowMobileSettings(false);
      setMessageMenuId(null);
      setShowEmoji(false);
    };

    document.addEventListener("pointerdown", closeFloatingMenus);
    document.addEventListener("keydown", closeFloatingMenusWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeFloatingMenus);
      document.removeEventListener("keydown", closeFloatingMenusWithKeyboard);
    };
  }, []);

  useEffect(() => {
    setShowThemes(false);
    setShowMobileSettings(false);
    setMessageMenuId(null);
  }, [screen]);

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
            setScreen("chats");
            return;
          }
          setDisplayName(resumableSession.displayName);
          setInvitation(resumableSession.invitation);
          if (
            resumableSession.role === "creator" &&
            (!resumableSession.expectedPeerIdentity || resumableSession.sharePending)
          ) {
            setInviteLink(invitationUrl(resumableSession.invitation));
          }
          setConnectionState("reconnecting");
          setScreen("waiting");
          pendingConversationRemovalRef.current =
            resumableSession.intent === "remove-conversation" && resumableSession.intentId
              ? { chatId: null, requestId: resumableSession.intentId }
              : null;
          if (resumableSession.intent === "remove-conversation") {
            setChatListNotice(chatHubCopy[language].reconnectDeleteNotice);
          }
          logDiagnostic("app", "session-resume-started", { role: resumableSession.role });
          startConnection(resumableSession.invitation, resumableSession.role, keys, {
            resume: true,
            expectedPeerIdentity: resumableSession.expectedPeerIdentity,
            displayName: resumableSession.displayName,
            reconnectCapability: resumableSession.reconnectCapability,
          });
        } else {
          setScreen(incomingInvite ? "home" : "chats");
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

  useEffect(() => {
    if (screen !== "chats") return;
    void refreshChatSummaries();
  }, [screen]);

  useEffect(() => () => {
    connectionRef.current?.close();
    for (const timer of pendingDeleteTimersRef.current.values()) window.clearTimeout(timer);
    for (const timer of pendingDeliveryTimersRef.current.values()) window.clearTimeout(timer);
    if (pendingClearTimerRef.current !== null) window.clearTimeout(pendingClearTimerRef.current);
    if (incomingRemovalAckTimerRef.current !== null) window.clearTimeout(incomingRemovalAckTimerRef.current);
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
    if (showSplash) return;
    const wasSecure = previousSecureRef.current;
    const isSecure = connectionState === "secure";
    previousSecureRef.current = isSecure;
    let connectTimer: number | null = null;
    if (isSecure && !wasSecure) {
      const startupElapsed = performance.now() - startupSoundAtRef.current;
      const delay = Math.max(0, 720 - startupElapsed);
      if (delay > 0) {
        connectTimer = window.setTimeout(() => void appSounds.play("connect"), delay);
      } else {
        void appSounds.play("connect");
      }
    }
    if (wasSecure && !isSecure) void appSounds.play("disconnect");
    return () => {
      if (connectTimer !== null) window.clearTimeout(connectTimer);
    };
  }, [connectionState, showSplash]);

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
    if (!list || !stickToMessageBottomRef.current) return;
    list.scrollTop = list.scrollHeight;
  }, [messages, incomingPhotoOffers, incomingClearRequest, historyNotice]);

  useEffect(() => {
    const markVisibleMessagesRead = () => {
      if (document.visibilityState !== "visible" || screen !== "chat" || !peerRef.current || !connectionRef.current) return;
      const connection = connectionRef.current;
      const unread = messages.filter((message) => message.sender === "peer" && message.status === "delivered");
      for (const message of unread) {
        void db.messages.update(message.id, { status: "read", readReceiptPending: true })
          .then(() => acknowledgeMessage(connection, message.id, "read"))
          .then(() => db.messages.update(message.id, { readReceiptPending: false }))
          .catch(handleLocalError);
      }
      if (unread.length) {
        const ids = new Set(unread.map((message) => message.id));
        setMessages((current) => current.map((message) => (
          ids.has(message.id) ? { ...message, status: "read", readReceiptPending: true } : message
        )));
      }
    };
    document.addEventListener("visibilitychange", markVisibleMessagesRead);
    return () => document.removeEventListener("visibilitychange", markVisibleMessagesRead);
  }, [messages, screen]);

  async function refreshChatSummaries() {
    const operation = chatListOperationRef.current;
    try {
      const summaries = await loadChatSummaries();
      if (operation === chatListOperationRef.current) setChatSummaries(summaries);
    } catch (reason) {
      logDiagnostic("storage", "chat-list-load-failed", { reason: safeErrorText(reason) }, "error");
      setChatListNotice(chatHubCopy[language].deleteFailed);
    }
  }

  async function openSavedChat(summary: StoredChatSummary) {
    const { contact: savedContact } = summary;
    closeActiveConversation();
    const operation = chatListOperationRef.current + 1;
    chatListOperationRef.current = operation;
    setChatListBusyId(savedContact.id);
    try {
      const [history, storedAttachments] = await Promise.all([
        loadMessages(savedContact.id),
        loadAttachments(savedContact.id),
      ]);
      if (operation !== chatListOperationRef.current) return;
      const unreadIds = history
        .filter((message) => message.sender === "peer" && message.status !== "read")
        .map((message) => message.id);
      if (unreadIds.length) {
        await Promise.all(unreadIds.map((id) => db.messages.update(id, {
          status: "read",
          readReceiptPending: true,
        })));
      }
      if (operation !== chatListOperationRef.current) return;
      const localHistory = history.map((message) => (
        unreadIds.includes(message.id)
          ? { ...message, status: "read" as const, readReceiptPending: true }
          : message
      ));
      const offlinePeer: SecurePeer = {
        id: savedContact.id,
        name: savedContact.name,
        identityKey: savedContact.identityKey,
        fingerprint: savedContact.fingerprint,
        securityCode: "",
      };
      stickToMessageBottomRef.current = true;
      setPeer(offlinePeer);
      setContact(savedContact);
      setMessages(localHistory);
      setAttachments(indexAttachments(storedAttachments));
      setConnectionState("closed");
      setScreen("chat");
      logDiagnostic("storage", "local-chat-opened", { messages: localHistory.length, attachments: storedAttachments.length });
    } catch (reason) {
      if (operation !== chatListOperationRef.current) return;
      logDiagnostic("storage", "local-chat-open-failed", { reason: safeErrorText(reason) }, "error");
      setChatListNotice(chatHubCopy[language].deleteFailed);
      setScreen("chats");
    } finally {
      if (operation === chatListOperationRef.current) setChatListBusyId(null);
    }
  }

  function reconnectSavedChat(summary: StoredChatSummary, removeConversation = false) {
    reconnectContact(summary.contact, removeConversation);
  }

  function reconnectContact(savedContact: StoredContact, removeConversation = false) {
    if (!identity) return;
    const savedLocalNameCandidate = savedContact.localName?.trim().normalize("NFC") ?? "";
    const savedLocalName = savedLocalNameCandidate.length >= 1 &&
        savedLocalNameCandidate.length <= 40 &&
        !/[\u0000-\u001f\u007f]/u.test(savedLocalNameCandidate)
      ? savedLocalNameCandidate
      : "";
    if (!savedLocalName && !validateName()) {
      goToNewChat();
      setError(t("error.name"));
      return;
    }
    closeActiveConversation();
    let reconnectCapability: ReconnectCapability | undefined;
    try {
      reconnectCapability = savedContact.reconnectCapability
        ? parseReconnectCapability(savedContact.reconnectCapability)
        : undefined;
    } catch (reason) {
      logDiagnostic("storage", "saved-reconnect-capability-invalid", {
        reason: safeErrorText(reason),
      }, "warn");
    }
    const nextInvitation: Invitation = reconnectCapability
      ? reconnectInvitation(reconnectCapability)
      : createInvitation(identity);
    const role: PeerRole = reconnectCapability?.role ?? "creator";
    const link = reconnectCapability ? "" : invitationUrl(nextInvitation);
    const normalizedName = savedLocalName || displayName.trim().normalize("NFC");
    const removalRequestId = removeConversation ? crypto.randomUUID() : undefined;
    writeResumableSession({
      invitation: nextInvitation,
      role,
      displayName: normalizedName,
      expectedPeerIdentity: savedContact.identityKey,
      ...(reconnectCapability ? { reconnectCapability } : { sharePending: true }),
      ...(removeConversation ? { intent: "remove-conversation" as const } : {}),
      ...(removalRequestId ? { intentId: removalRequestId } : {}),
    });
    pendingConversationRemovalRef.current = removalRequestId
      ? { chatId: savedContact.id, requestId: removalRequestId }
      : null;
    setChatListBusyId(savedContact.id);
    setChatListNotice(
      reconnectCapability
        ? removeConversation
          ? chatHubCopy[language].reconnectDeleteNotice
          : chatHubCopy[language].savedReconnectNotice
        : chatHubCopy[language].legacyReconnectNotice,
    );
    setInvitation(nextInvitation);
    setInviteLink(link);
    setConnectionState(reconnectCapability ? "reconnecting" : "connecting-signaling");
    setScreen("waiting");
    logDiagnostic("app", "known-contact-reconnect-started", {
      removeConversation,
      savedCapability: Boolean(reconnectCapability),
    });
    startConnection(nextInvitation, role, identity, {
      resume: Boolean(reconnectCapability),
      expectedPeerIdentity: savedContact.identityKey,
      displayName: normalizedName,
      reconnectCapability,
    });
  }

  async function deleteSavedChatLocally() {
    const target = chatDeleteTarget;
    if (!target) return;
    setChatDeleteTarget(null);
    const operation = chatListOperationRef.current + 1;
    chatListOperationRef.current = operation;
    setChatListBusyId(target.contact.id);
    try {
      await hideChatLocally(target.contact.id);
      const summaries = await loadChatSummaries();
      if (operation !== chatListOperationRef.current) return;
      setChatSummaries(summaries);
      setChatListNotice(chatHubCopy[language].deletedLocal);
      logDiagnostic("storage", "saved-chat-hidden");
    } catch (reason) {
      if (operation !== chatListOperationRef.current) return;
      logDiagnostic("storage", "saved-chat-hide-failed", { reason: safeErrorText(reason) }, "error");
      setChatListNotice(chatHubCopy[language].deleteFailed);
    } finally {
      if (operation === chatListOperationRef.current) setChatListBusyId(null);
    }
  }

  function deleteSavedChatForBoth() {
    const target = chatDeleteTarget;
    if (!target) return;
    setChatDeleteTarget(null);
    reconnectSavedChat(target, true);
  }

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
    options: {
      resume?: boolean;
      expectedPeerIdentity?: string;
      displayName?: string;
      reconnectCapability?: ReconnectCapability;
    } = {},
  ) {
    const generation = connectionGenerationRef.current + 1;
    connectionGenerationRef.current = generation;
    connectionRef.current?.close();
    const activeDisplayName = options.displayName ?? displayName.trim().normalize("NFC");
    let directConnection: DirectTalkConnection;
    directConnection = new DirectTalkConnection({
      roomId: nextInvitation.roomId,
      inviteSecret: decodeInvitationSecret(nextInvitation),
      role,
      identity: activeIdentity,
      displayName: activeDisplayName,
      expectedCreatorIdentity: role === "joiner" ? nextInvitation.creatorIdentity : undefined,
      expectedPeerIdentity: options.expectedPeerIdentity,
      reconnectCapability: options.reconnectCapability,
      resume: options.resume,
      onState: (state) => {
        if (generation !== connectionGenerationRef.current) return;
        logDiagnostic("app", "connection-state", { state });
        setConnectionState(state);
      },
      onSecure: (securePeer) => {
        if (generation !== connectionGenerationRef.current) return;
        logDiagnostic("app", "secure-peer-ready");
        void handleSecurePeer(securePeer, generation, activeDisplayName).catch(handleLocalError);
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

  async function handleSecurePeer(securePeer: SecurePeer, generation: number, activeDisplayName: string) {
    if (generation !== connectionGenerationRef.current) return;
    sessionStartedAtRef.current = Date.now();
    peerRef.current = securePeer;
    setPeer(securePeer);
    if (securePeer.reconnectCapability) {
      updateResumableReconnectCapability(securePeer.reconnectCapability, securePeer.identityKey);
    } else {
      updateResumablePeerIdentity(securePeer.identityKey);
    }
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
      localName: activeDisplayName,
      ...(securePeer.reconnectCapability
        ? { reconnectCapability: securePeer.reconnectCapability }
        : existing?.reconnectCapability
          ? { reconnectCapability: existing.reconnectCapability }
          : {}),
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
    stickToMessageBottomRef.current = true;
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
    logDiagnostic("storage", "chat-history-loaded", { messages: history.length, attachments: storedAttachments.length });
    setChatListBusyId(null);
    setScreen("chat");
    const pendingRemoval = pendingConversationRemovalRef.current;
    const removalPending = Boolean(
      pendingRemoval && (pendingRemoval.chatId === null || pendingRemoval.chatId === securePeer.id),
    );
    if (removalPending && generation === connectionGenerationRef.current) {
      pendingConversationRemovalRef.current = null;
      await requestClearForEveryone(true, pendingRemoval?.requestId);
      return;
    }

    await resendPendingTextMessages(recoveredHistory, generation);
    const connection = connectionRef.current;
    if (connection && generation === connectionGenerationRef.current) {
      const pendingReadReceipts = recoveredHistory.filter((message) => (
        message.sender === "peer" && message.status === "read" && message.readReceiptPending
      ));
      for (const message of pendingReadReceipts) {
        try {
          await acknowledgeMessage(connection, message.id, "read");
          await db.messages.update(message.id, { readReceiptPending: false });
          setMessages((current) => current.map((item) => (
            item.id === message.id ? { ...item, readReceiptPending: false } : item
          )));
        } catch (reason) {
          logDiagnostic("chat", "read-receipt-requeue-failed", { reason: safeErrorText(reason) }, "warn");
          break;
        }
      }
    }
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

    if (
      awaitingIncomingRemovalAckRef.current &&
      payload.kind !== "clear-chat-request" &&
      payload.kind !== "clear-chat-response"
    ) {
      logDiagnostic("chat", "payload-ignored-during-conversation-removal", { kind: payload.kind }, "warn");
      return;
    }

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
      const awaitingAck = awaitingIncomingRemovalAckRef.current;
      if (awaitingAck) {
        await connection.send({
          kind: "clear-chat-response",
          id: payload.id,
          accepted: awaitingAck.id === payload.id && payload.removeConversation === true,
          ...(payload.removeConversation === true ? { removeConversation: true } : {}),
        });
        return;
      }
      if (incomingClearRequestRef.current) {
        if (incomingClearRequestRef.current.id !== payload.id) {
          await connection.send({
            kind: "clear-chat-response",
            id: payload.id,
            accepted: false,
            ...(payload.removeConversation === true ? { removeConversation: true } : {}),
          });
        }
        return;
      }
      const operation = { id: payload.id, removeConversation: payload.removeConversation === true };
      incomingClearRequestRef.current = operation;
      setIncomingClearRequest(operation);
      return;
    }

    if (payload.kind === "clear-chat-response") {
      const awaitingAck = awaitingIncomingRemovalAckRef.current;
      if (
        awaitingAck?.id === payload.id &&
        awaitingAck.removeConversation &&
        payload.accepted &&
        payload.removeConversation === true
      ) {
        finishIncomingRemovalAckWait();
        goToChats();
        setChatListNotice(chatHubCopy[language].deletedBoth);
        return;
      }

      const operation = pendingClearRequestRef.current;
      if (!operation || operation.id !== payload.id) return;
      finishPendingClearRequest();
      if (!payload.accepted) {
        if (operation.removeConversation) clearResumableIntent();
        setHistoryNotice(t("notice.clearDeclined"));
        return;
      }
      try {
        await clearChatLocally(currentPeer.id, connection, operation.removeConversation);
        if (operation.removeConversation) {
          clearResumableIntent();
          if (payload.removeConversation === true) {
            try {
              await connection.send({
                kind: "clear-chat-response",
                id: operation.id,
                accepted: true,
                removeConversation: true,
              });
              // Give the reliable DataChannel a short window to flush the final
              // acknowledgement before closing this one-time connection.
              await new Promise((resolve) => window.setTimeout(resolve, 250));
            } catch (reason) {
              logDiagnostic("chat", "conversation-removal-ack-failed", {
                reason: safeErrorText(reason),
              }, "warn");
            }
          }
          goToChats();
          setChatListNotice(payload.removeConversation === true
            ? chatHubCopy[language].deletedBoth
            : chatHubCopy[language].deletedBothLegacy);
        } else {
          setHistoryNotice(t("notice.clearedEveryone"));
        }
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
    stickToMessageBottomRef.current = true;
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
    stickToMessageBottomRef.current = true;
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

  async function requestClearForEveryone(removeConversation = false, requestedId?: string) {
    const currentPeer = peerRef.current;
    if (!currentPeer) return;
    setShowClearDialog(false);
    setHistoryNotice("");
    const connection = connectionRef.current;
    if (!connection || pendingClearRequestRef.current) {
      setHistoryNotice(t("notice.clearUnavailable"));
      return;
    }

    const id = requestedId ?? crypto.randomUUID();
    const operation = { id, removeConversation };
    pendingClearRequestRef.current = operation;
    setPendingClearRequest(operation);
    setHistoryNotice(t("notice.clearWaiting"));
    pendingClearTimerRef.current = window.setTimeout(() => {
      if (pendingClearRequestRef.current?.id !== id) return;
      finishPendingClearRequest();
      if (removeConversation) clearResumableIntent();
      setHistoryNotice(t("notice.clearTimeout"));
    }, 20_000);
    try {
      await connection.send({
        kind: "clear-chat-request",
        id,
        ...(removeConversation ? { removeConversation: true } : {}),
      });
    } catch (reason) {
      finishPendingClearRequest();
      if (removeConversation) clearResumableIntent();
      setHistoryNotice(reason instanceof Error ? reason.message : t("notice.clearRequestFailed"));
    }
  }

  async function acceptIncomingClearRequest() {
    const operation = incomingClearRequestRef.current;
    const currentPeer = peerRef.current;
    const connection = connectionRef.current;
    if (!operation || !currentPeer || !connection) return;
    incomingClearRequestRef.current = null;
    setIncomingClearRequest(null);
    try {
      await clearChatLocally(currentPeer.id, connection, operation.removeConversation);
      if (operation.removeConversation) beginIncomingRemovalAckWait(operation);
      await connection.send({
        kind: "clear-chat-response",
        id: operation.id,
        accepted: true,
        ...(operation.removeConversation ? { removeConversation: true } : {}),
      });
      if (operation.removeConversation) {
        setHistoryNotice(chatHubCopy[language].waitingRemovalAck);
      } else {
        setHistoryNotice(t("notice.clearedEveryone"));
      }
    } catch (reason) {
      if (operation.removeConversation) {
        finishIncomingRemovalAckWait();
        goToChats();
        setChatListNotice(chatHubCopy[language].deletedHereOnly);
      } else {
        setHistoryNotice(reason instanceof Error ? reason.message : t("notice.clearFinishFailed"));
      }
    }
  }

  async function declineIncomingClearRequest() {
    const operation = incomingClearRequestRef.current;
    const connection = connectionRef.current;
    if (!operation) return;
    incomingClearRequestRef.current = null;
    setIncomingClearRequest(null);
    try {
      if (connection) {
        await connection.send({
          kind: "clear-chat-response",
          id: operation.id,
          accepted: false,
          ...(operation.removeConversation ? { removeConversation: true } : {}),
        });
      }
      setHistoryNotice(t("notice.clearRejected"));
    } catch (reason) {
      setHistoryNotice(reason instanceof Error ? reason.message : t("notice.clearRejectFailed"));
    }
  }

  async function clearChatLocally(
    chatId: string,
    connection: DirectTalkConnection | null,
    removeConversation = false,
  ) {
    chatGenerationRef.current += 1;
    await cancelAllPhotoTransfers(connection);
    clearPendingDeletes();
    clearDeliveryWatches();
    setMessageMenuId(null);
    setDeleteConfirmation(null);
    setPhotoError("");
    if (removeConversation) {
      await hideChatLocally(chatId);
    } else {
      await db.transaction("rw", db.messages, db.attachments, async () => {
        await db.attachments.where("chatId").equals(chatId).delete();
        await db.messages.where("chatId").equals(chatId).delete();
      });
    }
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

  function beginIncomingRemovalAckWait(operation: ClearChatOperation) {
    finishIncomingRemovalAckWait();
    awaitingIncomingRemovalAckRef.current = operation;
    setAwaitingRemovalAck(true);
    incomingRemovalAckTimerRef.current = window.setTimeout(() => {
      if (awaitingIncomingRemovalAckRef.current?.id !== operation.id) return;
      finishIncomingRemovalAckWait();
      goToChats();
      setChatListNotice(chatHubCopy[language].deletedHereOnly);
    }, 20_000);
  }

  function finishIncomingRemovalAckWait() {
    if (incomingRemovalAckTimerRef.current !== null) {
      window.clearTimeout(incomingRemovalAckTimerRef.current);
    }
    incomingRemovalAckTimerRef.current = null;
    awaitingIncomingRemovalAckRef.current = null;
    setAwaitingRemovalAck(false);
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

  function closeActiveConversation() {
    chatListOperationRef.current += 1;
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
    finishIncomingRemovalAckWait();
    pendingConversationRemovalRef.current = null;
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
    stickToMessageBottomRef.current = true;
    setConnectionState("closed");
  }

  function goToChats() {
    logDiagnostic("app", "returned-chat-list");
    closeActiveConversation();
    setChatListBusyId(null);
    setChatDeleteTarget(null);
    setChatListNotice("");
    setScreen("chats");
  }

  function goToNewChat() {
    logDiagnostic("app", "new-chat-opened");
    closeActiveConversation();
    setChatListBusyId(null);
    setChatDeleteTarget(null);
    setChatListNotice("");
    setScreen("home");
  }

  const activePeer = peer;
  const activeContact = contact;
  const activeMessages = messages;
  const activeAttachments = attachments;
  const hubCopy = chatHubCopy[language];
  const incomingTransfers = Object.values(photoTransfers).filter(
    (transfer) => transfer.direction === "incoming" && transfer.status !== "complete",
  );
  const isConversationOpen = screen === "chat";
  const connectionReady = connectionState === "secure";
  const conversationInteractive = connectionReady && !awaitingRemovalAck && !pendingClearRequest?.removeConversation;
  const offlineHistory = isConversationOpen && connectionState === "closed";
  const chatMarkState: OxalisState = connectionReady ? "online" : offlineHistory ? "offline" : "connecting";
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
        <button className="brand" type="button" onClick={screen === "chats" ? undefined : goToChats} aria-label={t("top.home")} disabled={screen === "chats"}>
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
            onClick={() => {
              setShowThemes(false);
              setShowMobileSettings(false);
              setShowDiagnostics(true);
            }}
            title={diagnosticsCopy[language].title}
            aria-label={diagnosticsCopy[language].title}
          >
            <span aria-hidden="true">i</span>
            <b>{diagnosticsCopy[language].button}</b>
          </button>
          <MobileSettingsMenu
            className="top-mobile-settings"
            open={showMobileSettings}
            onToggle={() => setShowMobileSettings((visible) => !visible)}
            onClose={() => setShowMobileSettings(false)}
            language={language}
            languagePreference={languagePreference}
            onLanguageChange={setLanguagePreference}
            theme={theme}
            onThemeChange={setTheme}
            soundsEnabled={soundsEnabled}
            onToggleSounds={toggleSounds}
            diagnosticsLabel={diagnosticsCopy[language].title}
            onOpenDiagnostics={() => setShowDiagnostics(true)}
          />
        </div>
      </header>

      {screen === "loading" && <StatusCard windowTitle={t("loading.window")} title={t("loading.title")} description={t("loading.description")} />}

      {screen === "chats" && (
        <section className="card chats-card y2k-window">
          <WindowTitlebar title={hubCopy.window} markState="offline" />
          {chatListNotice && (
            <div className="history-notice chat-list-notice" role="status">
              <span>{chatListNotice}</span>
              <button type="button" onClick={() => setChatListNotice("")} aria-label={t("notice.close")}>×</button>
            </div>
          )}
          <ChatListCard
            summaries={chatSummaries}
            language={language}
            copy={hubCopy}
            busyId={chatListBusyId}
            onNewChat={goToNewChat}
            onOpen={(summary) => void openSavedChat(summary)}
            onReconnect={(summary) => reconnectSavedChat(summary)}
            onDelete={setChatDeleteTarget}
          />
          <div className="window-statusbar">
            <span>● {hubCopy.localOnly}</span>
            <span>{chatSummaries.length} · {hubCopy.listStatus}</span>
            <span>v{APP_VERSION}</span>
          </div>

          {chatDeleteTarget && (
            <DialogBackdrop onClose={() => setChatDeleteTarget(null)}>
              <section className="confirm-dialog clear-dialog" role="dialog" aria-modal="true" aria-labelledby="chat-delete-dialog-title">
                <WindowTitlebar title={hubCopy.deleteWindow} onClose={() => setChatDeleteTarget(null)} closeLabel={t("common.close")} markState="offline" />
                <div className="confirm-dialog-body">
                  <div className="confirm-dialog-icon">!</div>
                  <div>
                    <h2 id="chat-delete-dialog-title">{hubCopy.deleteTitle}</h2>
                    <p>{hubCopy.deleteDescription}</p>
                  </div>
                </div>
                <div className="clear-dialog-options">
                  <button type="button" onClick={() => void deleteSavedChatLocally()}>
                    <strong>{hubCopy.deleteLocal}</strong><span>{hubCopy.deleteLocalDescription}</span>
                  </button>
                  <button type="button" onClick={deleteSavedChatForBoth}>
                    <strong>{hubCopy.deleteBoth}</strong><span>{hubCopy.deleteBothDescription}</span>
                  </button>
                </div>
                <div className="confirm-dialog-actions"><button type="button" data-dialog-initial-focus onClick={() => setChatDeleteTarget(null)}>{t("common.cancel")}</button></div>
              </section>
            </DialogBackdrop>
          )}
        </section>
      )}

      {screen === "home" && (
        <section className="card home-card y2k-window">
          <WindowTitlebar title={incomingInvite ? t("home.incomingWindow") : t("home.newWindow")} onClose={goToChats} closeLabel={t("common.close")} markState="offline" />
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
          <WindowTitlebar
            title={t("waiting.window")}
            onClose={goToChats}
            closeLabel={t("common.close")}
            markState="connecting"
          />
          <div className="waiting-body">
            <div className="pulse-lock"><LockIcon /></div>
            <div className="eyebrow">{t(stateLabelKeys[connectionState])}</div>
            <h1>{connectionState === "waiting-peer" || (connectionState === "waiting-reconnect" && inviteLink)
              ? t("waiting.invite")
              : connectionState === "reconnecting" || connectionState === "waiting-reconnect"
                ? t("waiting.restore")
                : t("waiting.channel")}</h1>

            {chatListNotice && <p className="waiting-context-notice" role="status">{chatListNotice}</p>}

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

            {!inviteLink && (connectionState === "reconnecting" || connectionState === "waiting-reconnect") && (
              <p className="quiet saved-reconnect-help">{t("waiting.savedHelp")}</p>
            )}

            {connectionState !== "waiting-peer" && <div className="connection-steps"><span className="active" /><span className="active" /><span /></div>}
            <button className="text-button" type="button" onClick={goToChats}>{t("waiting.cancel")}</button>
          </div>
          <div className="window-statusbar"><span>● DirectTalk network</span><span>{t("waiting.encryption")}</span></div>
        </section>
      )}

      {isConversationOpen && activePeer && activeContact && (
        <section className="chat-card y2k-window">
          <WindowTitlebar
            title={t("chat.with", { name: activePeer.name })}
            onClose={goToChats}
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
                <MobileSettingsMenu
                  className="chat-mobile-settings"
                  open={showMobileSettings}
                  onToggle={() => setShowMobileSettings((visible) => !visible)}
                  onClose={() => setShowMobileSettings(false)}
                  language={language}
                  languagePreference={languagePreference}
                  onLanguageChange={setLanguagePreference}
                  theme={theme}
                  onThemeChange={setTheme}
                  soundsEnabled={soundsEnabled}
                  onToggleSounds={toggleSounds}
                  diagnosticsLabel={diagnosticsCopy[language].title}
                  onOpenDiagnostics={() => setShowDiagnostics(true)}
                />
              </div>
            )}
          />
          <input
            ref={photoInputRef}
            className="visually-hidden"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            onChange={(event) => void handlePhotoSelection(event)}
            disabled={!conversationInteractive}
            tabIndex={-1}
          />

          <nav className="chat-toolbar" aria-label={t("chat.tools")}>
            <button className="active" type="button"><span>▤</span>{t("chat.messages")}</button>
            <button type="button" onClick={() => photoInputRef.current?.click()} disabled={!conversationInteractive} title={t("chat.photoTooltip")}><span>▧</span>{t("chat.photo")}<small>{t("chat.upTo10")}</small></button>
            <button type="button" disabled title={t("chat.voiceTooltip")}><span>◉</span>{t("chat.voice")}<small>{t("chat.soon")}</small></button>
            <button type="button" disabled title={t("chat.callTooltip")}><span>☎</span>{t("chat.call")}<small>{t("chat.soon")}</small></button>
            <button type="button" onClick={() => setShowClearDialog(true)} disabled={Boolean(pendingClearRequest) || awaitingRemovalAck} title={t("chat.clearTooltip")}><span>⌫</span>{t("chat.clear")}<small>{pendingClearRequest || awaitingRemovalAck ? t("chat.waiting") : t("chat.history")}</small></button>
            <button className="security-tool" type="button" onClick={() => setShowSecurity(!showSecurity)} aria-expanded={showSecurity}><span>◆</span>{t("chat.security")}</button>
          </nav>

          {!connectionReady && (
            <div className={`reconnect-banner ${offlineHistory ? "offline" : ""}`} role="status" aria-live="polite">
              <OxalisMark state={offlineHistory ? "offline" : "connecting"} />
              <div>
                <strong>{offlineHistory ? hubCopy.offlineTitle : t("peer.reconnecting")}</strong>
                <span>{offlineHistory ? hubCopy.offlineDescription : t("chat.reconnecting")}</span>
              </div>
              {offlineHistory && <button type="button" onClick={() => reconnectContact(activeContact)}>{hubCopy.reconnect}</button>}
            </div>
          )}

          {showSecurity && (
            <aside className="security-panel">
              {!offlineHistory && (
                <>
                  <div>
                    <span>{t("security.code")}</span>
                    <code>{activePeer.securityCode}</code>
                  </div>
                  <p>{t("security.description")}</p>
                </>
              )}
              {offlineHistory && <p>{hubCopy.offlineSecurity}</p>}
              <details>
                <summary>{t("security.fingerprint")}</summary>
                <code>{activePeer.fingerprint}</code>
              </details>
              {!activeContact.verified && connectionReady && <button type="button" onClick={() => void verifyContact()}>{t("security.match")}</button>}
            </aside>
          )}

          <div className="chat-workspace">
            <div className="conversation-pane">
              <div
                className="message-list"
                ref={messageListRef}
                aria-live="polite"
                onScroll={(event) => {
                  const list = event.currentTarget;
                  stickToMessageBottomRef.current = list.scrollHeight - list.scrollTop - list.clientHeight <= 80;
                }}
              >
                {connectionReady && <div className="session-notice"><LockIcon /> {t("session.secure")} · {formatTime(sessionStartedAtRef.current, language)}</div>}
                {incomingClearRequest && (
                  <section className="history-clear-request" role="alert">
                    <div>
                      <strong>{incomingClearRequest.removeConversation
                        ? hubCopy.incomingDeleteTitle.replace("{name}", activePeer.name)
                        : t("clearRequest.title", { name: activePeer.name })}</strong>
                      <span>{incomingClearRequest.removeConversation ? hubCopy.incomingDeleteDescription : t("clearRequest.description")}</span>
                    </div>
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
                    <div
                      className="photo-progress"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(transfer.progress * 100)}
                      aria-label={t("photo.progressReceived", { percent: Math.round(transfer.progress * 100) })}
                    ><i style={{ width: `${transfer.progress * 100}%` }} /></div>
                    {(transfer.status === "receiving") && <button type="button" onClick={() => void cancelPhotoTransfer(transfer.id)}>{t("common.cancel")}</button>}
                  </section>
                ))}
                {activeMessages.length === 0 && incomingPhotoOffers.length === 0 && incomingTransfers.length === 0 && (
                  <div className="empty-chat">
                    <OxalisMark state={chatMarkState} />
                    <strong>{connectionReady ? t("empty.online", { name: activePeer.name }) : offlineHistory ? hubCopy.offlineTitle : t("peer.reconnecting")}</strong>
                    <span>{connectionReady ? t("empty.prompt") : offlineHistory ? hubCopy.offlineDescription : t("chat.reconnecting")}</span>
                  </div>
                )}
                {activeMessages.map((message) => (
                  <article key={message.id} className={`message ${message.sender === "me" ? "mine" : "theirs"}`}>
                    <header>
                      <strong>{message.sender === "me" ? t("common.you") : activePeer.name}</strong>
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
                          <button type="button" role="menuitem" disabled={!conversationInteractive} onClick={() => {
                            setMessageMenuId(null);
                            setDeleteConfirmation({ messageId: message.id, scope: "everyone" });
                          }}>{t("message.deleteEveryone")}</button>
                        )}
                      </div>
                    )}
                  </article>
                ))}
              </div>

              {!offlineHistory && <form className="composer" onSubmit={(event) => void sendMessage(event)}>
                <textarea
                  ref={composerRef}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !window.matchMedia("(pointer: coarse)").matches) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  maxLength={4_000}
                  rows={3}
                  placeholder={t("message.placeholder", { name: activePeer.name })}
                  aria-label={t("message.label")}
                  disabled={!conversationInteractive}
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
                      disabled={!conversationInteractive}
                      aria-expanded={showEmoji}
                      title={t("emoji.label")}
                    >☺</button>
                    <button type="button" onClick={() => photoInputRef.current?.click()} disabled={!conversationInteractive} title={t("composer.photoTooltip")}>📎</button>
                    <button type="button" disabled title={t("composer.voiceTooltip")}>🎙</button>
                  </div>
                  <span className="draft-counter">{draft.length}/4000</span>
                  <button className="send-button" type="submit" disabled={!draft.trim() || !conversationInteractive}>{t("common.send")}</button>
                </div>
              </form>}
            </div>

            <aside className="peer-sidebar">
              <div className="peer-avatar" aria-hidden="true">{activePeer.name.slice(0, 1).toUpperCase()}</div>
              <div className="peer-online"><OxalisMark state={chatMarkState} /><strong>{activePeer.name}</strong></div>
              <span className={`presence ${connectionReady ? "" : "reconnecting"}`}>● {connectionReady ? t("peer.online") : offlineHistory ? hubCopy.offlinePresence : t("peer.reconnecting")}</span>
              <div className="peer-divider" />
              <button type="button" className={activeContact.verified ? "verified" : ""} onClick={() => setShowSecurity(!showSecurity)} aria-expanded={showSecurity}>
                <LockIcon />
                {activeContact.verified ? t("peer.verified") : t("peer.compare")}
              </button>
              <p>{offlineHistory ? hubCopy.offlineDescription : t("peer.directDescription")}</p>
            </aside>
          </div>

          {deleteConfirmation && (
            <DialogBackdrop onClose={() => setDeleteConfirmation(null)}>
              <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title">
                <WindowTitlebar title={t("delete.window")} onClose={() => setDeleteConfirmation(null)} closeLabel={t("common.close")} markState={chatMarkState} />
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
                  <button type="button" data-dialog-initial-focus onClick={() => setDeleteConfirmation(null)}>{t("common.cancel")}</button>
                  <button className="danger-button" type="button" onClick={() => void confirmMessageDeletion()}>{t("common.delete")}</button>
                </div>
              </section>
            </DialogBackdrop>
          )}

          {showClearDialog && (
            <DialogBackdrop onClose={() => setShowClearDialog(false)}>
              <section className="confirm-dialog clear-dialog" role="dialog" aria-modal="true" aria-labelledby="clear-dialog-title">
                <WindowTitlebar title={t("clear.window")} onClose={() => setShowClearDialog(false)} closeLabel={t("common.close")} markState={chatMarkState} />
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
                <div className="confirm-dialog-actions"><button type="button" data-dialog-initial-focus onClick={() => setShowClearDialog(false)}>{t("common.cancel")}</button></div>
              </section>
            </DialogBackdrop>
          )}

          <div className="window-statusbar"><span>● {activePeer.name}: {connectionReady ? t("peer.online") : offlineHistory ? hubCopy.offlinePresence : t("peer.reconnecting")}</span><span>{t("status.messages", { count: activeMessages.length })}</span><span>{connectionReady ? "WebRTC · E2EE" : offlineHistory ? hubCopy.localOnly : t("state.reconnecting")}</span></div>
        </section>
      )}

      {screen === "error" && (
        <section className="card error-card y2k-window">
          <WindowTitlebar
            title={t("error.window")}
            onClose={goToChats}
            closeLabel={t("common.close")}
            markState="offline"
          />
          <div className="error-body">
            <div className="error-icon">!</div>
            <h1>{t("error.title")}</h1>
            <p>{localizeRuntimeMessage(language, error)}</p>
            {errorDiagnosticId !== null && <code className="error-diagnostic-id">Diagnostic ID #{errorDiagnosticId}</code>}
            <button className="diagnostics-error-button" type="button" onClick={() => setShowDiagnostics(true)}>{diagnosticsCopy[language].button}</button>
            <button className="primary-button" type="button" onClick={goToChats}>{t("error.back")}</button>
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

function DialogBackdrop({
  children,
  onClose,
  className = "dialog-backdrop",
}: {
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = backdropRef.current?.querySelector<HTMLElement>('[role="dialog"]');
    const focusableSelector = [
      "button:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "input:not([disabled])",
      "a[href]",
      '[tabindex]:not([tabindex="-1"])',
    ].join(",");
    const focusInitial = window.requestAnimationFrame(() => {
      const initial = dialog?.querySelector<HTMLElement>("[data-dialog-initial-focus]")
        ?? dialog?.querySelector<HTMLElement>(focusableSelector);
      initial?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(focusableSelector)];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusInitial);
      document.removeEventListener("keydown", handleKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return (
    <div
      ref={backdropRef}
      className={className}
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) closeRef.current();
      }}
    >
      {children}
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
    <DialogBackdrop className="diagnostics-backdrop" onClose={onClose}>
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
            <button className="primary-button" data-dialog-initial-focus type="button" onClick={onClose}>{copy.close}</button>
          </div>
        </div>
      </section>
    </DialogBackdrop>
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
          <div
            className="photo-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(transfer.progress * 100)}
            aria-label={translate(language, "photo.progressReceived", { percent: Math.round(transfer.progress * 100) })}
          ><i style={{ width: `${transfer.progress * 100}%` }} /></div>
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
      {onClose && (
        <div className="window-controls">
          <button type="button" onClick={onClose} aria-label={closeLabel} title={closeLabel}>×</button>
        </div>
      )}
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

function MobileSettingsMenu({
  className,
  open,
  onToggle,
  onClose,
  language,
  languagePreference,
  onLanguageChange,
  theme,
  onThemeChange,
  soundsEnabled,
  onToggleSounds,
  diagnosticsLabel,
  onOpenDiagnostics,
}: {
  className: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  language: Language;
  languagePreference: LanguagePreference;
  onLanguageChange: (preference: LanguagePreference) => void;
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
  soundsEnabled: boolean;
  onToggleSounds: () => void;
  diagnosticsLabel: string;
  onOpenDiagnostics: () => void;
}) {
  const settingsLabel = translate(language, "top.settings");

  return (
    <div className={`mobile-settings ${className}`}>
      <button
        className="mobile-settings-trigger"
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={settingsLabel}
        title={settingsLabel}
      >
        <span aria-hidden="true">⚙</span>
      </button>
      {open && (
        <div className="mobile-settings-menu" role="dialog" aria-label={settingsLabel}>
          <strong>{settingsLabel}</strong>
          <label>
            <span>{translate(language, "language.label")}</span>
            <select
              value={languagePreference}
              onChange={(event) => onLanguageChange(event.target.value as LanguagePreference)}
            >
              <option value="auto">{translate(language, "language.auto")} · {language.toUpperCase()}</option>
              <option value="en">English</option>
              <option value="pl">Polski</option>
              <option value="ru">Русский</option>
              <option value="uk">Українська</option>
            </select>
          </label>
          <div className="mobile-theme-options" aria-label={translate(language, "theme.choose")}>
            {themeOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                className={theme === option.id ? "selected" : ""}
                onClick={() => {
                  onThemeChange(option.id);
                  onClose();
                }}
                aria-pressed={theme === option.id}
              >
                <span className={`theme-orb ${option.id}`} />
                {option.label}
              </button>
            ))}
          </div>
          <button className="mobile-settings-action" data-sound-control type="button" onClick={onToggleSounds} aria-pressed={soundsEnabled}>
            <SpeakerIcon muted={!soundsEnabled} />
            {soundsEnabled ? translate(language, "sound.on") : translate(language, "sound.off")}
          </button>
          <button className="mobile-settings-action" type="button" onClick={() => {
            onClose();
            onOpenDiagnostics();
          }}>
            <span className="mobile-settings-info" aria-hidden="true">i</span>
            {diagnosticsLabel}
          </button>
        </div>
      )}
    </div>
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
