export type Language = "en" | "pl" | "ru" | "uk";
export type LanguagePreference = "auto" | Language;

type TranslationParams = Record<string, string | number>;

const en = {
  "language.label": "Interface language",
  "language.auto": "Auto",
  "common.close": "Close",
  "common.cancel": "Cancel",
  "common.delete": "Delete",
  "common.accept": "Accept",
  "common.decline": "Decline",
  "common.copy": "Copy",
  "common.copied": "Copied ✓",
  "common.download": "Download",
  "common.send": "Send",
  "common.you": "You",
  "top.home": "Home",
  "top.private": "private mode",
  "theme.choose": "Choose theme",
  "theme.label": "Theme",
  "theme.appearance": "Appearance",
  "sound.enable": "Turn sounds on",
  "sound.disable": "Mute sounds",
  "sound.on": "Sounds on",
  "sound.off": "Sounds off",
  "splash.openSound": "Open DirectTalk with sound",
  "splash.silent": "Continue without sound",
  "splash.hint": "One tap starts the flower and sound together.",
  "state.connectingSignaling": "Connecting to the room",
  "state.waitingPeer": "Waiting for the other person",
  "state.connectingPeer": "Building a direct channel",
  "state.reconnecting": "Restoring the secure connection",
  "state.waitingReconnect": "Waiting for the other device",
  "state.authenticating": "Checking keys",
  "state.secure": "Secure channel",
  "state.closed": "Connection closed",
  "loading.window": "DirectTalk — starting",
  "loading.title": "Preparing the device key",
  "loading.description": "It will stay in this browser.",
  "home.incomingWindow": "Incoming conversation",
  "home.newWindow": "DirectTalk — new conversation",
  "home.eyebrow": "Direct private chat",
  "home.invitedTitle": "Someone invited you to chat",
  "home.greetingTitle": "Hi! Who is online today?",
  "home.lead": "A messenger with a 2000s mood and modern protection. Your history stays with you, while the conversation travels directly.",
  "home.nameLabel": "Your nickname in this browser",
  "home.namePlaceholder": "For example, sunny_boy_2003",
  "home.connect": "Connect",
  "home.create": "Create chat",
  "home.demo": "Open demo conversation",
  "home.encryptedTitle": "Encrypted browser to browser",
  "home.encryptedDescription": "The connection starts only after you click.",
  "home.features": "Features",
  "home.emoji": "Emoji",
  "home.statuses": "Statuses",
  "home.photos": "Photos up to 10 MB",
  "waiting.window": "DirectTalk — connecting",
  "waiting.invite": "Invite the other person",
  "waiting.channel": "Setting up a direct channel",
  "waiting.restore": "Restoring the conversation",
  "waiting.qrAlt": "QR code for a private invitation",
  "waiting.link": "One-time link",
  "waiting.help": "Send the link through a trusted channel or show the QR code in person.",
  "waiting.cancel": "Cancel connection",
  "waiting.encryption": "encryption enabled",
  "chat.demoTitle": "demo conversation",
  "chat.title": "conversation",
  "chat.tools": "Chat tools",
  "chat.messages": "Messages",
  "chat.photo": "Photo",
  "chat.upTo10": "up to 10 MB",
  "chat.voice": "Voice",
  "chat.call": "Call",
  "chat.soon": "soon",
  "chat.clear": "Clear",
  "chat.waiting": "waiting",
  "chat.history": "history",
  "chat.security": "Security",
  "chat.photoTooltip": "Send a photo up to 10 MB",
  "chat.voiceTooltip": "Voice messages will be added later",
  "chat.callTooltip": "Calls require a separate MediaStream",
  "chat.clearTooltip": "Clear conversation history",
  "chat.reconnecting": "Restoring the secure connection… Your history stays here.",
  "security.code": "Conversation code",
  "security.demoDescription": "This is a demo code. In a real conversation, compare it with the other person.",
  "security.description": "Compare the code by voice or in person. Matching codes prevent impersonation by the signaling server or someone who intercepted the link.",
  "security.fingerprint": "Device fingerprint",
  "security.match": "Codes match",
  "session.demo": "Demo mode · no connection",
  "session.secure": "Secure session started",
  "clearRequest.title": "{name} suggests clearing the whole conversation",
  "clearRequest.description": "Messages and photos will be deleted from IndexedDB in both browsers. This cannot be undone.",
  "clearRequest.accept": "Agree",
  "clearRequest.keep": "Keep history",
  "notice.close": "Close notification",
  "photo.offerTitle": "{name} is sending a photo",
  "photo.offerDescription": "The file will arrive directly and be stored only in this browser.",
  "photo.progressReceived": "Received {percent}%",
  "photo.unavailable": "This photo is unavailable in this browser.",
  "photo.preparing": "Preparing and calculating SHA-256…",
  "photo.waiting": "Waiting for the other person to confirm",
  "photo.sent": "Sent {percent}%",
  "photo.received": "Received {percent}%",
  "photo.complete": "Transfer complete",
  "photo.declined": "The other person declined the photo",
  "photo.cancelled": "Transfer cancelled",
  "photo.failed": "Could not transfer the photo",
  "photo.peerCancelled": "The other person cancelled the transfer",
  "photo.invalid": "Invalid photo data received",
  "photo.hashMismatch": "The photo checksum does not match",
  "photo.unsupported": "This photo format is not supported",
  "photo.transferFailed": "The photo transfer failed",
  "empty.online": "{name} is online now",
  "empty.prompt": "Write the first message or send an emoji.",
  "message.pendingDeletion": "Waiting for deletion confirmation",
  "message.actions": "Message actions",
  "message.deleteLocal": "Delete for me",
  "message.deleteEveryone": "Delete for both",
  "message.placeholder": "Message for {name}…",
  "message.label": "Message",
  "emoji.label": "Emoji",
  "emoji.classic": "Classic emoji",
  "emoji.add": "Add {emoji}",
  "composer.formatTooltip": "Formatting is not supported yet",
  "composer.photoTooltip": "Send a photo",
  "composer.voiceTooltip": "Voice messages will be added later",
  "peer.online": "Online",
  "peer.reconnecting": "Reconnecting",
  "peer.offline": "Offline",
  "peer.verified": "Verified contact",
  "peer.compare": "Compare code",
  "peer.demoDescription": "Local mockup: you can test themes and controls.",
  "peer.directDescription": "Messages travel directly between browsers.",
  "delete.window": "DirectTalk — deletion",
  "delete.title": "Delete message?",
  "delete.demoDescription": "In demo mode, deletion for the other person is only simulated.",
  "delete.everyoneDescription": "The request goes directly to the other person. You can delete for both only your own message while the connection is active.",
  "delete.localDescription": "The message will disappear only from this browser's history. The other person will keep it.",
  "clear.window": "DirectTalk — clear history",
  "clear.title": "Clear the whole conversation?",
  "clear.description": "All messages and photos in this chat will be deleted. DirectTalk cannot restore them.",
  "clear.local": "Only for me",
  "clear.localDescription": "The other person will keep their history",
  "clear.demo": "Clear demo",
  "clear.everyone": "For both",
  "clear.demoDescription": "Delete the mockup messages",
  "clear.everyoneDescription": "The other person must confirm",
  "status.messages": "{count} messages",
  "status.sending": "Sending",
  "status.delivered": "Delivered",
  "status.read": "Read",
  "status.failed": "Not sent",
  "error.window": "DirectTalk — connection error",
  "error.title": "Connection not established",
  "error.back": "Go back",
  "footer.history": "History is stored only in this browser",
  "demo.peer": "Sasha",
  "demo.message1": "Hi! Have you seen the new design yet? 🙂",
  "demo.message2": "Yes! It really feels like classic ICQ — in a good way.",
  "demo.message3": "Great! Let's add emoji, files and voice messages 📎",
  "demo.message4": "Emoji already work 😎 We'll add the rest in the next stage.",
  "notice.photoDeclined": "The other person declined the photo.",
  "notice.deleteDenied": "The other person did not allow this message to be deleted on their side.",
  "notice.invalidDeleteConfirmation": "Invalid deletion confirmation received.",
  "notice.deletedEveryone": "The message was deleted for both participants.",
  "notice.deletedRemoteLocalFailed": "The other person deleted the message, but local storage could not be updated.",
  "notice.clearDeclined": "The other person declined clearing the whole conversation.",
  "notice.clearedEveryone": "History was cleared for both participants.",
  "notice.clearedRemoteLocalFailed": "The other person cleared history, but local storage could not be updated.",
  "notice.demoDeleted": "In demo mode, the message was deleted from the local mockup.",
  "notice.deletedLocal": "The message was deleted only in this browser.",
  "notice.deleteOwnOnly": "You can delete only your own sent message on the other side while the conversation is active.",
  "notice.deleteRequestFailed": "Could not request message deletion.",
  "notice.deleteTimeout": "The other person did not confirm deletion. The message remains in history.",
  "notice.clearedLocal": "History was cleared only in this browser.",
  "notice.clearLocalFailed": "Could not clear local history.",
  "notice.demoCleared": "Demo history was cleared locally.",
  "notice.clearUnavailable": "A clear request is already pending or the connection is unavailable.",
  "notice.clearWaiting": "Waiting for confirmation before clearing the whole conversation…",
  "notice.clearTimeout": "The other person did not confirm clearing. History was kept.",
  "notice.clearRequestFailed": "Could not send the clear request.",
  "notice.clearFinishFailed": "Could not finish clearing history.",
  "notice.clearRejected": "The full clear request was declined.",
  "notice.clearRejectFailed": "Could not send the refusal.",
  "error.browser": "DirectTalk requires a modern browser and HTTPS (localhost is allowed for development).",
  "error.invite": "The invitation is damaged or uses an unsupported version.",
  "error.identity": "Could not create the device key.",
  "error.name": "Enter a name between 1 and 40 characters.",
  "error.photoOrder": "The photo chunks arrived out of order.",
  "error.photoChunkSize": "Invalid photo chunk size.",
  "error.photoOverflow": "More photo data was received than declared.",
  "error.photoIncomplete": "The photo was not received completely.",
  "error.photoReceive": "Could not receive the photo.",
  "error.photoSend": "Could not send the photo.",
  "error.messageSend": "The message was not sent.",
  "error.secureNotReady": "The secure connection is not ready yet.",
  "error.photoPrepare": "Could not prepare the photo.",
  "error.photoStart": "Could not start receiving the photo.",
  "error.storage": "Local storage error.",
  "error.clipboard": "The browser did not allow copying the link. Select it manually.",
  "error.photoResolution": "The photo resolution is too large.",
  "error.photoDecode": "The file could not be recognized as a photo.",
  "error.signaling": "Could not connect to the signaling service.",
  "error.peer": "The direct WebRTC connection failed or was closed.",
  "error.security": "The secure session data could not be verified.",
  "error.invalidData": "Invalid connection data received.",
  "error.generic": "An unexpected connection error occurred.",
} as const;

export type TranslationKey = keyof typeof en;
type Dictionary = Record<TranslationKey, string>;

const pl: Dictionary = {
  "language.label": "Język interfejsu", "language.auto": "Automatycznie",
  "common.close": "Zamknij", "common.cancel": "Anuluj", "common.delete": "Usuń", "common.accept": "Akceptuj", "common.decline": "Odrzuć", "common.copy": "Kopiuj", "common.copied": "Skopiowano ✓", "common.download": "Pobierz", "common.send": "Wyślij", "common.you": "Ty",
  "top.home": "Strona główna", "top.private": "tryb prywatny", "theme.choose": "Wybierz motyw", "theme.label": "Motyw", "theme.appearance": "Wygląd", "sound.enable": "Włącz dźwięki", "sound.disable": "Wycisz dźwięki", "sound.on": "Dźwięki włączone", "sound.off": "Dźwięki wyłączone", "splash.openSound": "Otwórz DirectTalk z dźwiękiem", "splash.silent": "Kontynuuj bez dźwięku", "splash.hint": "Jedno dotknięcie uruchomi kwiat i dźwięk razem.",
  "state.connectingSignaling": "Łączenie z pokojem", "state.waitingPeer": "Czekamy na rozmówcę", "state.connectingPeer": "Tworzenie kanału bezpośredniego", "state.reconnecting": "Przywracanie bezpiecznego połączenia", "state.waitingReconnect": "Czekamy na drugie urządzenie", "state.authenticating": "Sprawdzanie kluczy", "state.secure": "Bezpieczny kanał", "state.closed": "Połączenie zamknięte",
  "loading.window": "DirectTalk — uruchamianie", "loading.title": "Przygotowujemy klucz urządzenia", "loading.description": "Pozostanie w tej przeglądarce.",
  "home.incomingWindow": "Rozmowa przychodząca", "home.newWindow": "DirectTalk — nowa rozmowa", "home.eyebrow": "Bezpośredni prywatny czat", "home.invitedTitle": "Masz zaproszenie do rozmowy", "home.greetingTitle": "Cześć! Kto jest dziś online?", "home.lead": "Komunikator w klimacie lat 2000 z nowoczesną ochroną. Historia zostaje u Ciebie, a rozmowa biegnie bezpośrednio.", "home.nameLabel": "Twój pseudonim w tej przeglądarce", "home.namePlaceholder": "Na przykład sunny_boy_2003", "home.connect": "Połącz", "home.create": "Utwórz czat", "home.demo": "Otwórz rozmowę demo", "home.encryptedTitle": "Szyfrowanie między przeglądarkami", "home.encryptedDescription": "Połączenie zacznie się dopiero po kliknięciu.", "home.features": "Funkcje", "home.emoji": "Emoji", "home.statuses": "Statusy", "home.photos": "Zdjęcia do 10 MB",
  "waiting.window": "DirectTalk — łączenie", "waiting.invite": "Zaproś rozmówcę", "waiting.channel": "Konfigurujemy kanał bezpośredni", "waiting.restore": "Przywracanie rozmowy", "waiting.qrAlt": "Kod QR prywatnego zaproszenia", "waiting.link": "Link jednorazowy", "waiting.help": "Wyślij link zaufanym kanałem albo pokaż kod QR osobiście.", "waiting.cancel": "Anuluj połączenie", "waiting.encryption": "szyfrowanie włączone",
  "chat.demoTitle": "rozmowa demo", "chat.title": "rozmowa", "chat.tools": "Narzędzia czatu", "chat.messages": "Wiadomości", "chat.photo": "Zdjęcie", "chat.upTo10": "do 10 MB", "chat.voice": "Głos", "chat.call": "Połączenie", "chat.soon": "wkrótce", "chat.clear": "Wyczyść", "chat.waiting": "czekamy", "chat.history": "historię", "chat.security": "Ochrona", "chat.photoTooltip": "Wyślij zdjęcie do 10 MB", "chat.voiceTooltip": "Wiadomości głosowe pojawią się później", "chat.callTooltip": "Połączenia wymagają osobnego MediaStream", "chat.clearTooltip": "Wyczyść historię rozmowy", "chat.reconnecting": "Przywracamy bezpieczne połączenie… Historia pozostaje tutaj.",
  "security.code": "Kod rozmowy", "security.demoDescription": "To kod demonstracyjny. W prawdziwej rozmowie porównaj go z rozmówcą.", "security.description": "Porównaj kod głosowo lub osobiście. Zgodne kody wykluczają podszycie się serwera signalingowego lub osoby, która przejęła link.", "security.fingerprint": "Odcisk urządzenia", "security.match": "Kody są zgodne",
  "session.demo": "Tryb demo · bez połączenia", "session.secure": "Bezpieczna sesja rozpoczęta",
  "clearRequest.title": "{name} proponuje wyczyścić całą rozmowę", "clearRequest.description": "Wiadomości i zdjęcia zostaną usunięte z IndexedDB obu przeglądarek. Nie można tego cofnąć.", "clearRequest.accept": "Zgadzam się", "clearRequest.keep": "Zachowaj historię", "notice.close": "Zamknij powiadomienie",
  "photo.offerTitle": "{name} wysyła zdjęcie", "photo.offerDescription": "Plik trafi bezpośrednio i zostanie zapisany tylko w tej przeglądarce.", "photo.progressReceived": "Odebrano {percent}%", "photo.unavailable": "Zdjęcie jest niedostępne w tej przeglądarce.", "photo.preparing": "Przygotowywanie i obliczanie SHA-256…", "photo.waiting": "Czekamy na potwierdzenie rozmówcy", "photo.sent": "Wysłano {percent}%", "photo.received": "Odebrano {percent}%", "photo.complete": "Transfer zakończony", "photo.declined": "Rozmówca odrzucił zdjęcie", "photo.cancelled": "Transfer anulowany", "photo.failed": "Nie udało się przesłać zdjęcia", "photo.peerCancelled": "Rozmówca anulował transfer", "photo.invalid": "Odebrano nieprawidłowe dane zdjęcia", "photo.hashMismatch": "Suma kontrolna zdjęcia się nie zgadza", "photo.unsupported": "Ten format zdjęcia nie jest obsługiwany", "photo.transferFailed": "Transfer zdjęcia zakończył się błędem",
  "empty.online": "{name} jest teraz online", "empty.prompt": "Napisz pierwszą wiadomość lub wyślij emoji.",
  "message.pendingDeletion": "Oczekiwanie na potwierdzenie usunięcia", "message.actions": "Działania wiadomości", "message.deleteLocal": "Usuń u mnie", "message.deleteEveryone": "Usuń u obu", "message.placeholder": "Wiadomość do {name}…", "message.label": "Wiadomość", "emoji.label": "Emoji", "emoji.classic": "Klasyczne emoji", "emoji.add": "Dodaj {emoji}", "composer.formatTooltip": "Formatowanie nie jest jeszcze obsługiwane", "composer.photoTooltip": "Wyślij zdjęcie", "composer.voiceTooltip": "Wiadomości głosowe zostaną dodane później",
  "peer.online": "Online", "peer.reconnecting": "Ponowne łączenie", "peer.offline": "Offline", "peer.verified": "Kontakt zweryfikowany", "peer.compare": "Porównaj kod", "peer.demoDescription": "Lokalna makieta: możesz testować motywy i elementy sterujące.", "peer.directDescription": "Wiadomości biegną bezpośrednio między przeglądarkami.",
  "delete.window": "DirectTalk — usuwanie", "delete.title": "Usunąć wiadomość?", "delete.demoDescription": "W trybie demo usunięcie u rozmówcy jest tylko symulowane.", "delete.everyoneDescription": "Żądanie trafi bezpośrednio do rozmówcy. U obu stron możesz usunąć tylko własną wiadomość, gdy połączenie jest aktywne.", "delete.localDescription": "Wiadomość zniknie tylko z historii tej przeglądarki. Rozmówca ją zachowa.",
  "clear.window": "DirectTalk — czyszczenie historii", "clear.title": "Wyczyścić całą rozmowę?", "clear.description": "Wszystkie wiadomości i zdjęcia tego czatu zostaną usunięte. DirectTalk nie może ich przywrócić.", "clear.local": "Tylko u mnie", "clear.localDescription": "Rozmówca zachowa swoją historię", "clear.demo": "Wyczyść demo", "clear.everyone": "U obu", "clear.demoDescription": "Usuń wiadomości makiety", "clear.everyoneDescription": "Rozmówca musi potwierdzić",
  "status.messages": "Wiadomości: {count}", "status.sending": "Wysyłanie", "status.delivered": "Dostarczono", "status.read": "Przeczytano", "status.failed": "Nie wysłano",
  "error.window": "DirectTalk — błąd połączenia", "error.title": "Nie nawiązano połączenia", "error.back": "Wróć", "footer.history": "Historia jest przechowywana tylko w tej przeglądarce",
  "demo.peer": "Sasha", "demo.message1": "Cześć! Widziałeś już nowy projekt? 🙂", "demo.message2": "Tak! Bardzo przypomina stare ICQ — w dobrym sensie.", "demo.message3": "Świetnie! Dodajmy emoji, pliki i wiadomości głosowe 📎", "demo.message4": "Emoji już działają 😎 Resztę dodamy w następnym etapie.",
  "notice.photoDeclined": "Rozmówca odrzucił zdjęcie.", "notice.deleteDenied": "Rozmówca nie pozwolił usunąć tej wiadomości u siebie.", "notice.invalidDeleteConfirmation": "Odebrano nieprawidłowe potwierdzenie usunięcia.", "notice.deletedEveryone": "Wiadomość usunięto u obu uczestników.", "notice.deletedRemoteLocalFailed": "Rozmówca usunął wiadomość, ale nie udało się zaktualizować lokalnego magazynu.", "notice.clearDeclined": "Rozmówca odrzucił wyczyszczenie całej rozmowy.", "notice.clearedEveryone": "Historia została wyczyszczona u obu uczestników.", "notice.clearedRemoteLocalFailed": "Rozmówca wyczyścił historię, ale nie udało się zaktualizować lokalnego magazynu.", "notice.demoDeleted": "W trybie demo wiadomość usunięto z lokalnej makiety.", "notice.deletedLocal": "Wiadomość usunięto tylko w tej przeglądarce.", "notice.deleteOwnOnly": "U rozmówcy można usunąć tylko własną wysłaną wiadomość podczas aktywnej rozmowy.", "notice.deleteRequestFailed": "Nie udało się zażądać usunięcia wiadomości.", "notice.deleteTimeout": "Rozmówca nie potwierdził usunięcia. Wiadomość pozostaje w historii.", "notice.clearedLocal": "Historię wyczyszczono tylko w tej przeglądarce.", "notice.clearLocalFailed": "Nie udało się wyczyścić lokalnej historii.", "notice.demoCleared": "Historię demo wyczyszczono lokalnie.", "notice.clearUnavailable": "Żądanie czyszczenia już oczekuje albo połączenie jest niedostępne.", "notice.clearWaiting": "Czekamy na potwierdzenie przed wyczyszczeniem całej rozmowy…", "notice.clearTimeout": "Rozmówca nie potwierdził czyszczenia. Historia została zachowana.", "notice.clearRequestFailed": "Nie udało się wysłać żądania czyszczenia.", "notice.clearFinishFailed": "Nie udało się zakończyć czyszczenia historii.", "notice.clearRejected": "Żądanie pełnego czyszczenia zostało odrzucone.", "notice.clearRejectFailed": "Nie udało się wysłać odmowy.",
  "error.browser": "DirectTalk wymaga nowoczesnej przeglądarki i HTTPS (localhost jest dozwolony podczas tworzenia).", "error.invite": "Zaproszenie jest uszkodzone lub korzysta z nieobsługiwanej wersji.", "error.identity": "Nie udało się utworzyć klucza urządzenia.", "error.name": "Wpisz nazwę o długości od 1 do 40 znaków.", "error.photoOrder": "Części zdjęcia dotarły w złej kolejności.", "error.photoChunkSize": "Nieprawidłowy rozmiar części zdjęcia.", "error.photoOverflow": "Odebrano więcej danych zdjęcia, niż zadeklarowano.", "error.photoIncomplete": "Zdjęcie nie zostało odebrane w całości.", "error.photoReceive": "Nie udało się odebrać zdjęcia.", "error.photoSend": "Nie udało się wysłać zdjęcia.", "error.messageSend": "Wiadomość nie została wysłana.", "error.secureNotReady": "Bezpieczne połączenie nie jest jeszcze gotowe.", "error.photoPrepare": "Nie udało się przygotować zdjęcia.", "error.photoStart": "Nie udało się rozpocząć odbierania zdjęcia.", "error.storage": "Błąd lokalnego magazynu.", "error.clipboard": "Przeglądarka nie pozwoliła skopiować linku. Zaznacz go ręcznie.", "error.photoResolution": "Rozdzielczość zdjęcia jest zbyt duża.", "error.photoDecode": "Nie udało się rozpoznać pliku jako zdjęcia.", "error.signaling": "Nie udało się połączyć z usługą signalingową.", "error.peer": "Bezpośrednie połączenie WebRTC nie powiodło się lub zostało zamknięte.", "error.security": "Nie udało się zweryfikować danych bezpiecznej sesji.", "error.invalidData": "Odebrano nieprawidłowe dane połączenia.", "error.generic": "Wystąpił nieoczekiwany błąd połączenia.",
};

const ru: Dictionary = {
  "language.label": "Язык интерфейса", "language.auto": "Авто",
  "common.close": "Закрыть", "common.cancel": "Отмена", "common.delete": "Удалить", "common.accept": "Принять", "common.decline": "Отклонить", "common.copy": "Копировать", "common.copied": "Скопировано ✓", "common.download": "Скачать", "common.send": "Отправить", "common.you": "Вы",
  "top.home": "На главную", "top.private": "приватный режим", "theme.choose": "Выбрать тему", "theme.label": "Тема", "theme.appearance": "Оформление", "sound.enable": "Включить звуки", "sound.disable": "Выключить звуки", "sound.on": "Звуки включены", "sound.off": "Звуки выключены", "splash.openSound": "Открыть DirectTalk со звуком", "splash.silent": "Продолжить без звука", "splash.hint": "Одно нажатие запустит цветок и звук вместе.",
  "state.connectingSignaling": "Подключаемся к комнате", "state.waitingPeer": "Ждём собеседника", "state.connectingPeer": "Строим прямой канал", "state.reconnecting": "Восстанавливаем защищённое соединение", "state.waitingReconnect": "Ждём второе устройство", "state.authenticating": "Проверяем ключи", "state.secure": "Защищённый канал", "state.closed": "Соединение закрыто",
  "loading.window": "DirectTalk — запуск", "loading.title": "Готовим ключ устройства", "loading.description": "Он останется в этом браузере.",
  "home.incomingWindow": "Входящий разговор", "home.newWindow": "DirectTalk — новый разговор", "home.eyebrow": "Прямой приватный чат", "home.invitedTitle": "Вас приглашают поговорить", "home.greetingTitle": "Привет! Кто сегодня онлайн?", "home.lead": "Мессенджер с настроением нулевых и современной защитой. История остаётся у вас, а разговор идёт напрямую.", "home.nameLabel": "Ваш ник в этом браузере", "home.namePlaceholder": "Например, sunny_boy_2003", "home.connect": "Подключиться", "home.create": "Создать чат", "home.demo": "Посмотреть демо диалога", "home.encryptedTitle": "Зашифровано от браузера до браузера", "home.encryptedDescription": "Подключение начинается только после вашего нажатия.", "home.features": "Возможности", "home.emoji": "Смайлики", "home.statuses": "Статусы", "home.photos": "Фото до 10 МБ",
  "waiting.window": "DirectTalk — подключение", "waiting.invite": "Позовите собеседника", "waiting.channel": "Настраиваем прямой канал", "waiting.restore": "Восстанавливаем разговор", "waiting.qrAlt": "QR-код приватного приглашения", "waiting.link": "Одноразовая ссылка", "waiting.help": "Отправьте ссылку через доверенный канал или покажите QR лично.", "waiting.cancel": "Отменить подключение", "waiting.encryption": "шифрование включено",
  "chat.demoTitle": "демо диалога", "chat.title": "разговор", "chat.tools": "Инструменты чата", "chat.messages": "Сообщения", "chat.photo": "Фото", "chat.upTo10": "до 10 МБ", "chat.voice": "Голос", "chat.call": "Звонок", "chat.soon": "скоро", "chat.clear": "Очистить", "chat.waiting": "ожидаем", "chat.history": "историю", "chat.security": "Защита", "chat.photoTooltip": "Отправить фотографию до 10 МБ", "chat.voiceTooltip": "Голосовые сообщения появятся позже", "chat.callTooltip": "Звонки требуют отдельного MediaStream", "chat.clearTooltip": "Очистить историю разговора", "chat.reconnecting": "Восстанавливаем защищённое соединение… История остаётся здесь.",
  "security.code": "Код этого разговора", "security.demoDescription": "Это демонстрационный код. В настоящем разговоре его нужно сравнить с собеседником.", "security.description": "Сравните код голосом или лично. Одинаковый код исключает подмену signaling-сервером или человеком, перехватившим ссылку.", "security.fingerprint": "Отпечаток устройства", "security.match": "Коды совпали",
  "session.demo": "Демо-режим · без подключения", "session.secure": "Защищённый сеанс начат",
  "clearRequest.title": "{name} предлагает очистить весь разговор", "clearRequest.description": "Сообщения и фотографии будут удалены из IndexedDB обоих браузеров. Отменить это действие нельзя.", "clearRequest.accept": "Согласиться", "clearRequest.keep": "Оставить историю", "notice.close": "Закрыть уведомление",
  "photo.offerTitle": "{name} отправляет фотографию", "photo.offerDescription": "Файл загрузится напрямую и сохранится только в этом браузере.", "photo.progressReceived": "Получено {percent}%", "photo.unavailable": "Фотография недоступна в этом браузере.", "photo.preparing": "Подготавливаем и считаем SHA-256…", "photo.waiting": "Ожидаем подтверждения собеседника", "photo.sent": "Отправлено {percent}%", "photo.received": "Получено {percent}%", "photo.complete": "Передача завершена", "photo.declined": "Собеседник отклонил фотографию", "photo.cancelled": "Передача отменена", "photo.failed": "Не удалось передать фотографию", "photo.peerCancelled": "Собеседник отменил передачу", "photo.invalid": "Получены некорректные данные фотографии", "photo.hashMismatch": "Контрольная сумма фотографии не совпала", "photo.unsupported": "Формат фотографии не поддерживается", "photo.transferFailed": "Передача фотографии завершилась ошибкой",
  "empty.online": "{name} сейчас онлайн", "empty.prompt": "Напишите первое сообщение или отправьте смайлик.",
  "message.pendingDeletion": "Ожидаем подтверждения удаления", "message.actions": "Действия с сообщением", "message.deleteLocal": "Удалить у меня", "message.deleteEveryone": "Удалить у обоих", "message.placeholder": "Сообщение для {name}…", "message.label": "Сообщение", "emoji.label": "Смайлики", "emoji.classic": "Классические смайлики", "emoji.add": "Добавить {emoji}", "composer.formatTooltip": "Форматирование пока не поддерживается", "composer.photoTooltip": "Отправить фотографию", "composer.voiceTooltip": "Голосовые сообщения будут добавлены позже",
  "peer.online": "В сети", "peer.reconnecting": "Переподключаемся", "peer.offline": "Не в сети", "peer.verified": "Контакт проверен", "peer.compare": "Сверить код", "peer.demoDescription": "Локальный макет: можно проверять темы и элементы управления.", "peer.directDescription": "Сообщения идут напрямую между браузерами.",
  "delete.window": "DirectTalk — удаление", "delete.title": "Удалить сообщение?", "delete.demoDescription": "В демо-режиме удаление у собеседника только имитируется.", "delete.everyoneDescription": "Запрос уйдёт напрямую собеседнику. Удалить у обоих можно только своё сообщение, пока соединение активно.", "delete.localDescription": "Сообщение исчезнет только из истории этого браузера. У собеседника оно останется.",
  "clear.window": "DirectTalk — очистка истории", "clear.title": "Очистить весь разговор?", "clear.description": "Будут удалены все сообщения и фотографии этого чата. Восстановить их через DirectTalk нельзя.", "clear.local": "Только у меня", "clear.localDescription": "Собеседник сохранит свою историю", "clear.demo": "Очистить демо", "clear.everyone": "У обоих", "clear.demoDescription": "Удалить сообщения макета", "clear.everyoneDescription": "Собеседник должен подтвердить",
  "status.messages": "{count} сообщ.", "status.sending": "Отправляется", "status.delivered": "Доставлено", "status.read": "Прочитано", "status.failed": "Не отправлено",
  "error.window": "DirectTalk — ошибка подключения", "error.title": "Соединение не установлено", "error.back": "Вернуться", "footer.history": "История хранится только в этом браузере",
  "demo.peer": "Саша", "demo.message1": "Привет! Ты уже посмотрел новый дизайн? 🙂", "demo.message2": "Да! Очень напоминает старую аську — в хорошем смысле.", "demo.message3": "Класс! Давай добавим смайлики, файлы и голосовые 📎", "demo.message4": "Смайлики уже работают 😎 Остальное добавим следующим этапом.",
  "notice.photoDeclined": "Собеседник отклонил фотографию.", "notice.deleteDenied": "Собеседник не разрешил удалить это сообщение у себя.", "notice.invalidDeleteConfirmation": "Получено некорректное подтверждение удаления.", "notice.deletedEveryone": "Сообщение удалено у обоих участников.", "notice.deletedRemoteLocalFailed": "Собеседник удалил сообщение, но локальное хранилище не удалось обновить.", "notice.clearDeclined": "Собеседник отклонил полную очистку разговора.", "notice.clearedEveryone": "История очищена у обоих участников.", "notice.clearedRemoteLocalFailed": "Собеседник очистил историю, но локальное хранилище не удалось обновить.", "notice.demoDeleted": "В демо-режиме сообщение удалено из локального макета.", "notice.deletedLocal": "Сообщение удалено только в этом браузере.", "notice.deleteOwnOnly": "У собеседника можно удалить только своё отправленное сообщение во время активного разговора.", "notice.deleteRequestFailed": "Не удалось запросить удаление сообщения.", "notice.deleteTimeout": "Собеседник не подтвердил удаление. Сообщение оставлено в истории.", "notice.clearedLocal": "История очищена только в этом браузере.", "notice.clearLocalFailed": "Не удалось очистить локальную историю.", "notice.demoCleared": "Демо-история очищена локально.", "notice.clearUnavailable": "Запрос на очистку уже отправлен или соединение недоступно.", "notice.clearWaiting": "Ждём подтверждения собеседника перед полной очисткой…", "notice.clearTimeout": "Собеседник не подтвердил очистку. История сохранена.", "notice.clearRequestFailed": "Не удалось отправить запрос на очистку.", "notice.clearFinishFailed": "Не удалось завершить очистку истории.", "notice.clearRejected": "Запрос на полную очистку отклонён.", "notice.clearRejectFailed": "Не удалось отправить отказ.",
  "error.browser": "DirectTalk требует современный браузер и HTTPS (localhost разрешён для разработки).", "error.invite": "Приглашение повреждено или использует неподдерживаемую версию.", "error.identity": "Не удалось создать ключ устройства.", "error.name": "Введите имя длиной от 1 до 40 символов.", "error.photoOrder": "Нарушен порядок частей фотографии.", "error.photoChunkSize": "Некорректный размер части фотографии.", "error.photoOverflow": "Получено больше данных, чем заявлено.", "error.photoIncomplete": "Фотография получена не полностью.", "error.photoReceive": "Не удалось принять фотографию.", "error.photoSend": "Не удалось отправить фотографию.", "error.messageSend": "Сообщение не отправлено.", "error.secureNotReady": "Защищённое соединение ещё не готово.", "error.photoPrepare": "Не удалось подготовить фотографию.", "error.photoStart": "Не удалось начать получение.", "error.storage": "Ошибка локального хранилища.", "error.clipboard": "Браузер не разрешил скопировать ссылку. Выделите её вручную.", "error.photoResolution": "Слишком большое разрешение фотографии.", "error.photoDecode": "Файл не удалось распознать как фотографию.", "error.signaling": "Не удалось подключиться к signaling-сервису.", "error.peer": "Прямое WebRTC-соединение не удалось установить или оно было закрыто.", "error.security": "Не удалось проверить данные защищённого сеанса.", "error.invalidData": "Получены некорректные данные соединения.", "error.generic": "Произошла непредвиденная ошибка соединения.",
};

const uk: Dictionary = {
  "language.label": "Мова інтерфейсу", "language.auto": "Авто",
  "common.close": "Закрити", "common.cancel": "Скасувати", "common.delete": "Видалити", "common.accept": "Прийняти", "common.decline": "Відхилити", "common.copy": "Копіювати", "common.copied": "Скопійовано ✓", "common.download": "Завантажити", "common.send": "Надіслати", "common.you": "Ви",
  "top.home": "На головну", "top.private": "приватний режим", "theme.choose": "Вибрати тему", "theme.label": "Тема", "theme.appearance": "Оформлення", "sound.enable": "Увімкнути звуки", "sound.disable": "Вимкнути звуки", "sound.on": "Звуки ввімкнено", "sound.off": "Звуки вимкнено", "splash.openSound": "Відкрити DirectTalk зі звуком", "splash.silent": "Продовжити без звуку", "splash.hint": "Один дотик запустить квітку і звук разом.",
  "state.connectingSignaling": "Підключення до кімнати", "state.waitingPeer": "Чекаємо на співрозмовника", "state.connectingPeer": "Створення прямого каналу", "state.reconnecting": "Відновлення захищеного з'єднання", "state.waitingReconnect": "Чекаємо на інший пристрій", "state.authenticating": "Перевірка ключів", "state.secure": "Захищений канал", "state.closed": "З'єднання закрито",
  "loading.window": "DirectTalk — запуск", "loading.title": "Готуємо ключ пристрою", "loading.description": "Він залишиться в цьому браузері.",
  "home.incomingWindow": "Вхідна розмова", "home.newWindow": "DirectTalk — нова розмова", "home.eyebrow": "Прямий приватний чат", "home.invitedTitle": "Вас запрошують поговорити", "home.greetingTitle": "Привіт! Хто сьогодні онлайн?", "home.lead": "Месенджер із настроєм нульових і сучасним захистом. Історія залишається у вас, а розмова йде напряму.", "home.nameLabel": "Ваш нік у цьому браузері", "home.namePlaceholder": "Наприклад, sunny_boy_2003", "home.connect": "Підключитися", "home.create": "Створити чат", "home.demo": "Відкрити демо-розмову", "home.encryptedTitle": "Зашифровано від браузера до браузера", "home.encryptedDescription": "Підключення почнеться лише після вашого натискання.", "home.features": "Можливості", "home.emoji": "Смайлики", "home.statuses": "Статуси", "home.photos": "Фото до 10 МБ",
  "waiting.window": "DirectTalk — підключення", "waiting.invite": "Запросіть співрозмовника", "waiting.channel": "Налаштовуємо прямий канал", "waiting.restore": "Відновлення розмови", "waiting.qrAlt": "QR-код приватного запрошення", "waiting.link": "Одноразове посилання", "waiting.help": "Надішліть посилання через довірений канал або покажіть QR особисто.", "waiting.cancel": "Скасувати підключення", "waiting.encryption": "шифрування ввімкнено",
  "chat.demoTitle": "демо-розмова", "chat.title": "розмова", "chat.tools": "Інструменти чату", "chat.messages": "Повідомлення", "chat.photo": "Фото", "chat.upTo10": "до 10 МБ", "chat.voice": "Голос", "chat.call": "Дзвінок", "chat.soon": "згодом", "chat.clear": "Очистити", "chat.waiting": "очікуємо", "chat.history": "історію", "chat.security": "Захист", "chat.photoTooltip": "Надіслати фото до 10 МБ", "chat.voiceTooltip": "Голосові повідомлення з'являться пізніше", "chat.callTooltip": "Дзвінки потребують окремого MediaStream", "chat.clearTooltip": "Очистити історію розмови", "chat.reconnecting": "Відновлюємо захищене з'єднання… Історія залишається тут.",
  "security.code": "Код цієї розмови", "security.demoDescription": "Це демонстраційний код. У справжній розмові порівняйте його зі співрозмовником.", "security.description": "Порівняйте код голосом або особисто. Однакові коди виключають підміну signaling-сервером або людиною, що перехопила посилання.", "security.fingerprint": "Відбиток пристрою", "security.match": "Коди збігаються",
  "session.demo": "Демо-режим · без підключення", "session.secure": "Захищений сеанс розпочато",
  "clearRequest.title": "{name} пропонує очистити всю розмову", "clearRequest.description": "Повідомлення та фотографії буде видалено з IndexedDB обох браузерів. Скасувати це неможливо.", "clearRequest.accept": "Погодитися", "clearRequest.keep": "Залишити історію", "notice.close": "Закрити сповіщення",
  "photo.offerTitle": "{name} надсилає фотографію", "photo.offerDescription": "Файл надійде напряму й збережеться лише в цьому браузері.", "photo.progressReceived": "Отримано {percent}%", "photo.unavailable": "Фотографія недоступна в цьому браузері.", "photo.preparing": "Підготовка та обчислення SHA-256…", "photo.waiting": "Чекаємо на підтвердження співрозмовника", "photo.sent": "Надіслано {percent}%", "photo.received": "Отримано {percent}%", "photo.complete": "Передачу завершено", "photo.declined": "Співрозмовник відхилив фотографію", "photo.cancelled": "Передачу скасовано", "photo.failed": "Не вдалося передати фотографію", "photo.peerCancelled": "Співрозмовник скасував передачу", "photo.invalid": "Отримано некоректні дані фотографії", "photo.hashMismatch": "Контрольна сума фотографії не збігається", "photo.unsupported": "Цей формат фотографії не підтримується", "photo.transferFailed": "Передача фотографії завершилася помилкою",
  "empty.online": "{name} зараз онлайн", "empty.prompt": "Напишіть перше повідомлення або надішліть смайлик.",
  "message.pendingDeletion": "Очікуємо на підтвердження видалення", "message.actions": "Дії з повідомленням", "message.deleteLocal": "Видалити у мене", "message.deleteEveryone": "Видалити в обох", "message.placeholder": "Повідомлення для {name}…", "message.label": "Повідомлення", "emoji.label": "Смайлики", "emoji.classic": "Класичні смайлики", "emoji.add": "Додати {emoji}", "composer.formatTooltip": "Форматування поки не підтримується", "composer.photoTooltip": "Надіслати фотографію", "composer.voiceTooltip": "Голосові повідомлення буде додано пізніше",
  "peer.online": "Онлайн", "peer.reconnecting": "Перепідключення", "peer.offline": "Офлайн", "peer.verified": "Контакт перевірено", "peer.compare": "Звірити код", "peer.demoDescription": "Локальний макет: можна перевіряти теми та елементи керування.", "peer.directDescription": "Повідомлення йдуть напряму між браузерами.",
  "delete.window": "DirectTalk — видалення", "delete.title": "Видалити повідомлення?", "delete.demoDescription": "У демо-режимі видалення у співрозмовника лише імітується.", "delete.everyoneDescription": "Запит піде напряму співрозмовнику. Видалити в обох можна лише власне повідомлення, поки з'єднання активне.", "delete.localDescription": "Повідомлення зникне лише з історії цього браузера. У співрозмовника воно залишиться.",
  "clear.window": "DirectTalk — очищення історії", "clear.title": "Очистити всю розмову?", "clear.description": "Усі повідомлення та фотографії цього чату буде видалено. DirectTalk не зможе їх відновити.", "clear.local": "Лише у мене", "clear.localDescription": "Співрозмовник збереже свою історію", "clear.demo": "Очистити демо", "clear.everyone": "В обох", "clear.demoDescription": "Видалити повідомлення макета", "clear.everyoneDescription": "Співрозмовник має підтвердити",
  "status.messages": "{count} повід.", "status.sending": "Надсилається", "status.delivered": "Доставлено", "status.read": "Прочитано", "status.failed": "Не надіслано",
  "error.window": "DirectTalk — помилка підключення", "error.title": "З'єднання не встановлено", "error.back": "Повернутися", "footer.history": "Історія зберігається лише в цьому браузері",
  "demo.peer": "Саша", "demo.message1": "Привіт! Ти вже бачив новий дизайн? 🙂", "demo.message2": "Так! Дуже нагадує стару аську — у хорошому сенсі.", "demo.message3": "Клас! Додаймо смайлики, файли та голосові 📎", "demo.message4": "Смайлики вже працюють 😎 Решту додамо на наступному етапі.",
  "notice.photoDeclined": "Співрозмовник відхилив фотографію.", "notice.deleteDenied": "Співрозмовник не дозволив видалити це повідомлення у себе.", "notice.invalidDeleteConfirmation": "Отримано некоректне підтвердження видалення.", "notice.deletedEveryone": "Повідомлення видалено в обох учасників.", "notice.deletedRemoteLocalFailed": "Співрозмовник видалив повідомлення, але локальне сховище не вдалося оновити.", "notice.clearDeclined": "Співрозмовник відхилив повне очищення розмови.", "notice.clearedEveryone": "Історію очищено в обох учасників.", "notice.clearedRemoteLocalFailed": "Співрозмовник очистив історію, але локальне сховище не вдалося оновити.", "notice.demoDeleted": "У демо-режимі повідомлення видалено з локального макета.", "notice.deletedLocal": "Повідомлення видалено лише в цьому браузері.", "notice.deleteOwnOnly": "У співрозмовника можна видалити лише власне надіслане повідомлення під час активної розмови.", "notice.deleteRequestFailed": "Не вдалося запросити видалення повідомлення.", "notice.deleteTimeout": "Співрозмовник не підтвердив видалення. Повідомлення залишено в історії.", "notice.clearedLocal": "Історію очищено лише в цьому браузері.", "notice.clearLocalFailed": "Не вдалося очистити локальну історію.", "notice.demoCleared": "Демо-історію очищено локально.", "notice.clearUnavailable": "Запит на очищення вже надіслано або з'єднання недоступне.", "notice.clearWaiting": "Чекаємо на підтвердження перед повним очищенням…", "notice.clearTimeout": "Співрозмовник не підтвердив очищення. Історію збережено.", "notice.clearRequestFailed": "Не вдалося надіслати запит на очищення.", "notice.clearFinishFailed": "Не вдалося завершити очищення історії.", "notice.clearRejected": "Запит на повне очищення відхилено.", "notice.clearRejectFailed": "Не вдалося надіслати відмову.",
  "error.browser": "DirectTalk потребує сучасного браузера й HTTPS (localhost дозволено для розробки).", "error.invite": "Запрошення пошкоджене або використовує непідтримувану версію.", "error.identity": "Не вдалося створити ключ пристрою.", "error.name": "Введіть ім'я довжиною від 1 до 40 символів.", "error.photoOrder": "Порушено порядок частин фотографії.", "error.photoChunkSize": "Некоректний розмір частини фотографії.", "error.photoOverflow": "Отримано більше даних, ніж заявлено.", "error.photoIncomplete": "Фотографію отримано не повністю.", "error.photoReceive": "Не вдалося прийняти фотографію.", "error.photoSend": "Не вдалося надіслати фотографію.", "error.messageSend": "Повідомлення не надіслано.", "error.secureNotReady": "Захищене з'єднання ще не готове.", "error.photoPrepare": "Не вдалося підготувати фотографію.", "error.photoStart": "Не вдалося почати отримання.", "error.storage": "Помилка локального сховища.", "error.clipboard": "Браузер не дозволив скопіювати посилання. Виділіть його вручну.", "error.photoResolution": "Роздільна здатність фотографії завелика.", "error.photoDecode": "Файл не вдалося розпізнати як фотографію.", "error.signaling": "Не вдалося підключитися до signaling-сервісу.", "error.peer": "Пряме WebRTC-з'єднання не вдалося встановити або його було закрито.", "error.security": "Не вдалося перевірити дані захищеного сеансу.", "error.invalidData": "Отримано некоректні дані з'єднання.", "error.generic": "Сталася неочікувана помилка з'єднання.",
};

const dictionaries: Record<Language, Dictionary> = { en, pl, ru, uk };

export const languageLocale: Record<Language, string> = {
  en: "en",
  pl: "pl",
  ru: "ru",
  uk: "uk",
};

export function translate(language: Language, key: TranslationKey, params: TranslationParams = {}): string {
  return dictionaries[language][key].replace(/\{(\w+)\}/gu, (placeholder, name: string) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : placeholder
  ));
}

export function resolveLanguage(
  preference: LanguagePreference,
  browserLanguages: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages,
): Language {
  if (preference !== "auto") return preference;
  for (const browserLanguage of browserLanguages) {
    const primary = browserLanguage.toLowerCase().split(/[-_]/u)[0];
    if (primary === "en" || primary === "pl" || primary === "ru" || primary === "uk") return primary;
  }
  return "en";
}

export function readLanguagePreference(): LanguagePreference {
  try {
    const stored = localStorage.getItem("directtalk.language");
    if (stored === "auto" || stored === "en" || stored === "pl" || stored === "ru" || stored === "uk") return stored;
  } catch {
    // Browser preferences still work when localStorage is unavailable.
  }
  return "auto";
}

export function writeLanguagePreference(preference: LanguagePreference): void {
  try {
    localStorage.setItem("directtalk.language", preference);
  } catch {
    // Language persistence is optional.
  }
}

export function localizeRuntimeMessage(language: Language, message: string): string {
  if (language === "ru") return message.trim();
  const normalized = message.trim();
  if (/фотограф|част[ьи] фотограф|файл/iu.test(normalized)) {
    if (/разрешен/iu.test(normalized)) return translate(language, "error.photoResolution");
    if (/распознать/iu.test(normalized)) return translate(language, "error.photoDecode");
    if (/формат|JPEG|PNG|WebP|GIF/iu.test(normalized)) return translate(language, "photo.unsupported");
    if (/контрольн|сумм|hash/iu.test(normalized)) return translate(language, "photo.hashMismatch");
    return translate(language, "error.photoReceive");
  }
  if (/signaling/iu.test(normalized)) return translate(language, "error.signaling");
  if (/WebRTC|DataChannel|Прямое соединение/iu.test(normalized)) return translate(language, "error.peer");
  if (/handshake|секрет|ключ|подпис|защищ|nonce|последовательност/iu.test(normalized)) return translate(language, "error.security");
  if (/приглашен|base64url|идентификатор комнаты/iu.test(normalized)) return translate(language, "error.invite");
  if (/некоррект|неизвестн|пакет|SDP|ICE candidate/iu.test(normalized)) return translate(language, "error.invalidData");
  if (/[А-Яа-яЁё]/u.test(normalized)) return translate(language, "error.generic");
  return normalized;
}
