import { required } from "../shared/required.ts";
import { larkChatsEnabled } from "./config";
import { LarkApiError, lark } from "./lark";
import { activeLarkUsersByOpenIds, HttpError } from "./store";

type Page<T> = { items: T[]; has_more: boolean; page_token?: string };
type Chat = { chat_id: string; name: string; description?: string; chat_status?: string };
type Member = { member_id: string; member_id_type: string };

// Each browser request reads one Lark page. Large groups don't exhaust a Worker's
// subrequest budget, and the composer only adds members after every page succeeds.
async function chatPage<T>(path: string, cursor: string | undefined, query: Record<string, string> = {}) {
  if (!larkChatsEnabled()) throw new HttpError(409, "lark_chats_not_configured");
  if (cursor && cursor.length > 2048) throw new HttpError(400, "lark_chat_invalid");
  try {
    const data = await lark<Page<T>>("GET", path, { ...query, page_size: "100", page_token: cursor });
    if (
      !data ||
      !Array.isArray(data.items) ||
      typeof data.has_more !== "boolean" ||
      (data.has_more && (!data.page_token || data.page_token === cursor))
    ) {
      throw new Error("Incomplete Lark chat page");
    }
    return { items: data.items, nextCursor: data.has_more ? required(data.page_token) : null };
  } catch (e) {
    if (e instanceof LarkApiError) {
      if ([99991672, 99991676, 99991679, 232025, 232034].includes(e.code)) {
        throw new HttpError(403, "lark_chats_permission");
      }
      if ([232006, 232009, 232010, 232011, 232033].includes(e.code)) {
        throw new HttpError(403, "lark_chat_unavailable");
      }
    }
    console.error("lark chats", e);
    throw new HttpError(502, "lark_chats_failed");
  }
}

export async function listLarkChats(cursor?: string) {
  // Unlike chat search, this lists only groups the bot has joined, whose members
  // it can read. ByCreateTimeAsc keeps pagination stable as groups become active.
  const page = await chatPage<Chat>("/open-apis/im/v1/chats", cursor, { sort_type: "ByCreateTimeAsc" });
  return {
    chats: page.items
      .filter((c) => !c.chat_status || c.chat_status === "normal")
      .map((c) => ({ id: c.chat_id, name: c.name, description: c.description ?? "" })),
    nextCursor: page.nextCursor,
  };
}

export async function larkChatMembers(chatId: string, cursor?: string) {
  if (!/^oc_[a-zA-Z0-9_-]{1,128}$/.test(chatId)) throw new HttpError(400, "lark_chat_invalid");
  const page = await chatPage<Member>(`/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members`, cursor, {
    member_id_type: "open_id",
  });
  if (page.items.some((m) => m.member_id_type !== "open_id" || !m.member_id)) {
    throw new HttpError(502, "lark_chats_failed");
  }
  const ids = [...new Set(page.items.map((m) => m.member_id))];
  const users = await activeLarkUsersByOpenIds(ids);
  return { users, skipped: ids.length - Object.keys(users).length, nextCursor: page.nextCursor };
}
