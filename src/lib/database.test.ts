import { describe, expect, it } from "vitest";
import {
  aggregateChatSummaries,
  type StoredContact,
  type StoredMessage,
} from "./database";

function contact(id: string, lastSeenAt: number, hiddenAt?: number): StoredContact {
  return {
    id,
    name: id,
    identityKey: `identity-${id}`,
    fingerprint: `fingerprint-${id}`,
    verified: id === "verified",
    firstSeenAt: 1,
    lastSeenAt,
    ...(hiddenAt === undefined ? {} : { hiddenAt }),
  };
}

function message(
  id: string,
  chatId: string,
  createdAt: number,
  sender: StoredMessage["sender"] = "peer",
  status: StoredMessage["status"] = "delivered",
): StoredMessage {
  return { id, chatId, createdAt, sender, status, text: id };
}

describe("chat summary aggregation", () => {
  it("groups messages, selects the latest one and counts unread incoming messages", () => {
    const summaries = aggregateChatSummaries(
      [contact("alice", 100)],
      [
        message("old", "alice", 200, "peer", "read"),
        message("latest", "alice", 400, "me", "delivered"),
        message("unread", "alice", 300),
      ],
    );

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      contact: { id: "alice" },
      lastMessage: { id: "latest" },
      messageCount: 3,
      unreadCount: 1,
      activityAt: 400,
    });
  });

  it("filters locally hidden contacts and ignores orphan messages", () => {
    const summaries = aggregateChatSummaries(
      [contact("visible", 10), contact("hidden", 20, 30)],
      [
        message("visible-message", "visible", 11),
        message("hidden-message", "hidden", 40),
        message("orphan-message", "missing", 50),
      ],
    );

    expect(summaries.map((summary) => summary.contact.id)).toEqual(["visible"]);
    expect(summaries[0]?.messageCount).toBe(1);
  });

  it("sorts by the latest contact or message activity", () => {
    const summaries = aggregateChatSummaries(
      [contact("recent-contact", 500), contact("recent-message", 100), contact("quiet", 50)],
      [message("activity", "recent-message", 600)],
    );

    expect(summaries.map((summary) => [summary.contact.id, summary.activityAt])).toEqual([
      ["recent-message", 600],
      ["recent-contact", 500],
      ["quiet", 50],
    ]);
    expect(summaries[2]?.lastMessage).toBeUndefined();
  });
});
