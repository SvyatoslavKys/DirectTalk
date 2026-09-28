import { useId } from "react";
import type { Language } from "../lib/i18n";
import type { StoredChatSummary } from "../lib/database";

export interface ChatListCopy {
  heading: string;
  newChat: string;
  emptyTitle: string;
  emptyDescription: string;
  verified: string;
  photo: string;
  noMessages: string;
  messages: string;
  unread: string;
  open: string;
  reconnect: string;
  delete: string;
}

export interface ChatListCardProps {
  summaries: readonly StoredChatSummary[];
  language: Language;
  copy: ChatListCopy;
  onNewChat: () => void;
  onOpen: (summary: StoredChatSummary) => void;
  onReconnect: (summary: StoredChatSummary) => void;
  onDelete: (summary: StoredChatSummary) => void;
  busyId?: string | null;
  formatTimestamp?: (timestamp: number, language: Language) => string;
}

const localeByLanguage: Record<Language, string> = {
  en: "en-US",
  pl: "pl-PL",
  ru: "ru-RU",
  uk: "uk-UA",
};

function defaultFormatTimestamp(timestamp: number, language: Language): string {
  if (!Number.isFinite(timestamp)) return "";

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";

  return new Intl.DateTimeFormat(localeByLanguage[language], {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function avatarInitial(name: string): string {
  const normalized = name.trim();
  return Array.from(normalized)[0]?.toLocaleUpperCase() ?? "?";
}

function messagePreview(summary: StoredChatSummary, copy: ChatListCopy): string {
  const message = summary.lastMessage;
  if (!message) return copy.noMessages;
  if (message.kind === "photo") return copy.photo;
  return message.text.trim() || copy.noMessages;
}

export function ChatListCard({
  summaries,
  language,
  copy,
  onNewChat,
  onOpen,
  onReconnect,
  onDelete,
  busyId,
  formatTimestamp = defaultFormatTimestamp,
}: ChatListCardProps) {
  const headingId = useId();

  return (
    <section className="chat-list-card" aria-labelledby={headingId}>
      <header className="chat-list-card__header">
        <h1 id={headingId}>{copy.heading}</h1>
        <button className="chat-list-card__new" type="button" onClick={onNewChat} disabled={Boolean(busyId)}>
          {copy.newChat}
        </button>
      </header>

      {summaries.length === 0 ? (
        <div className="chat-list-card__empty" role="status">
          <strong>{copy.emptyTitle}</strong>
          <p>{copy.emptyDescription}</p>
        </div>
      ) : (
        <ul className="chat-list" aria-label={copy.heading}>
          {summaries.map((summary) => {
            const { contact } = summary;
            const isBusy = busyId === contact.id;
            const controlsBusy = Boolean(busyId);
            const preview = messagePreview(summary, copy);
            const timestamp = summary.lastMessage?.createdAt ?? summary.activityAt;
            const formattedTimestamp = formatTimestamp(timestamp, language);

            return (
              <li className="chat-list__item" key={contact.id} aria-busy={isBusy || undefined}>
                <div className="chat-list__avatar" aria-hidden="true">
                  {avatarInitial(contact.name)}
                </div>

                <div className="chat-list__content">
                  <div className="chat-list__identity">
                    <strong>{contact.name}</strong>
                    {contact.verified && (
                      <span className="chat-list__verified" aria-label={copy.verified} title={copy.verified}>
                        ✓
                      </span>
                    )}
                  </div>
                  <p className="chat-list__preview" title={preview}>{preview}</p>
                  <div className="chat-list__meta">
                    {formattedTimestamp && (
                      <time dateTime={new Date(timestamp).toISOString()}>{formattedTimestamp}</time>
                    )}
                    <span aria-label={`${summary.messageCount} ${copy.messages}`}>
                      {summary.messageCount} {copy.messages}
                    </span>
                    {summary.unreadCount > 0 && (
                      <span
                        className="chat-list__unread"
                        aria-label={`${summary.unreadCount} ${copy.unread}`}
                        title={`${summary.unreadCount} ${copy.unread}`}
                      >
                        {summary.unreadCount}
                      </span>
                    )}
                  </div>
                </div>

                <div className="chat-list__actions">
                  <button
                    type="button"
                    onClick={() => onOpen(summary)}
                    disabled={controlsBusy}
                    aria-label={`${copy.open}: ${contact.name}`}
                    title={`${copy.open}: ${contact.name}`}
                  >
                    {copy.open}
                  </button>
                  <button
                    type="button"
                    onClick={() => onReconnect(summary)}
                    disabled={controlsBusy}
                    aria-label={`${copy.reconnect}: ${contact.name}`}
                    title={`${copy.reconnect}: ${contact.name}`}
                  >
                    {copy.reconnect}
                  </button>
                  <button
                    className="chat-list__delete"
                    type="button"
                    onClick={() => onDelete(summary)}
                    disabled={controlsBusy}
                    aria-label={`${copy.delete}: ${contact.name}`}
                    title={`${copy.delete}: ${contact.name}`}
                  >
                    {copy.delete}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
