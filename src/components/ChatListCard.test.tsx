import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StoredChatSummary } from "../lib/database";
import { ChatListCard, type ChatListCopy } from "./ChatListCard";

const copy: ChatListCopy = {
  heading: "Your chats",
  newChat: "New chat",
  emptyTitle: "No chats",
  emptyDescription: "Create one",
  verified: "Verified",
  photo: "Photo",
  noMessages: "No messages",
  messages: "messages",
  unread: "unread",
  open: "Open",
  reconnect: "Reconnect",
  delete: "Delete",
};

function render(summaries: StoredChatSummary[]) {
  return renderToStaticMarkup(
    <ChatListCard
      summaries={summaries}
      language="en"
      copy={copy}
      onNewChat={() => undefined}
      onOpen={() => undefined}
      onReconnect={() => undefined}
      onDelete={() => undefined}
      formatTimestamp={() => "Sep 27, 16:30"}
    />,
  );
}

describe("ChatListCard", () => {
  it("renders a useful empty state", () => {
    const markup = render([]);
    expect(markup).toContain("No chats");
    expect(markup).toContain("Create one");
    expect(markup).toContain("New chat");
  });

  it("renders saved chat metadata and all three actions", () => {
    const markup = render([{
      contact: {
        id: "peer-id",
        name: "Sasha",
        identityKey: "identity",
        fingerprint: "fingerprint",
        verified: true,
        firstSeenAt: 1,
        lastSeenAt: 2,
      },
      lastMessage: {
        id: "message-id",
        chatId: "peer-id",
        sender: "peer",
        text: "Hello",
        createdAt: 3,
        status: "delivered",
      },
      messageCount: 4,
      unreadCount: 1,
      activityAt: 3,
    }]);

    expect(markup).toContain("Sasha");
    expect(markup).toContain("Hello");
    expect(markup).toContain("Verified");
    expect(markup).toContain("4 messages");
    expect(markup).toContain("1 unread");
    expect(markup).toContain("Open");
    expect(markup).toContain("Reconnect");
    expect(markup).toContain("Delete");
  });
});
