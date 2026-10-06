import { config, emailNotifyEnabled, larkNotifyEnabled } from "./config";
import { db } from "./db";
import { sendEmailNotices } from "./email";
import { sendLarkNotices } from "./lark";
import { valueById } from "../shared/values";

// Who hears about a new thanks, and in what words. The channels (lark.ts, email.ts) only
// decide how to deliver each Notice:
//   recipient  "X thanked you"                   Lark DM, email
//   cc         "X thanked Y · cc'd to you"       Lark DM, email
//   sender     "you thanked Y" (a receipt)       Lark DM only
//   broadcast  "X thanked Y", public posts only  the Lark group (LARK_BROADCAST_CHAT_ID)
// Nobody gets a second notice about their own post, even when they thanked or CC'd themselves.

export const copy = {
  zh: {
    kudos: (s: string) => `${s} 夸了你`,
    bonus: (s: string, p: number) => `${s} 给你发了一份 Peer Bonus · +${p}`,
    open: "去看看",
    broadcastKudos: (s: string, r: string) => `${s} 夸了 ${r}`,
    broadcastBonus: (s: string, r: string, p: number) => `${s} 给 ${r} 发了 Peer Bonus · 每人 +${p}`,
    sentKudos: (r: string) => `你夸了 ${r}`,
    sentBonus: (r: string, p: number, many: boolean) => `你给 ${r} 发了 Peer Bonus · ${many ? "每人 " : ""}+${p}`,
    ccKudos: (s: string, r: string) => `${s} 夸了 ${r} · 抄送给你`,
    ccBonus: (s: string, r: string) => `${s} 给 ${r} 发了 Peer Bonus · 抄送给你`,
    ccNote: (names: string) => `抄送：${names}`,
    remaining: (n: number) => `本月剩余 ${n} 积分`,
    private: "🔒 秘密夸夸 · 仅相关的人可见",
    andMore: (n: number) => `等 ${n} 人`,
    sep: "、",
    // email
    replyHint: (s: string) => `直接回复这封邮件，就能回复 ${s}。`,
    optOut: "不想收到这类邮件？在你的个人主页关闭邮件通知",
    testSubject: "夸夸邮件通知测试",
    testBody: (from: string) => `这是一封测试邮件：夸夸可以从 ${from} 给大家发邮件通知了。`,
  },
  en: {
    kudos: (s: string) => `${s} sent you kudos`,
    bonus: (s: string, p: number) => `${s} sent you a Peer Bonus · +${p}`,
    open: "Open",
    broadcastKudos: (s: string, r: string) => `${s} gave kudos to ${r}`,
    broadcastBonus: (s: string, r: string, p: number) => `${s} sent ${r} a Peer Bonus · +${p} each`,
    sentKudos: (r: string) => `You gave kudos to ${r}`,
    sentBonus: (r: string, p: number, many: boolean) => `You sent ${r} a Peer Bonus · +${p}${many ? " each" : ""}`,
    ccKudos: (s: string, r: string) => `${s} gave kudos to ${r} · cc'd to you`,
    ccBonus: (s: string, r: string) => `${s} sent ${r} a Peer Bonus · cc'd to you`,
    ccNote: (names: string) => `CC: ${names}`,
    remaining: (n: number) => `${n} pts left this month`,
    private: "🔒 Private · only the people on it can see it",
    andMore: (n: number) => ` and ${n} others`,
    sep: ", ",
    replyHint: (s: string) => `Reply to this email to reply to ${s}.`,
    optOut: "Don't want these emails? Turn them off on your profile",
    testSubject: "Kuakua email test",
    testBody: (from: string) => `This is a test: Kuakua can now send email notifications from ${from}.`,
  },
};

export type Lang = keyof typeof copy;
export const langOf = (p: { lang: string | null }): Lang => (p.lang === "en" ? "en" : "zh");
export const site = () => `夸夸 · ${new URL(config.publicUrl).host}`;

export type NotifyPost = {
  id: number;
  kind: "kudos" | "bonus";
  message: string;
  valueTag: string | null;
  points: number;
  senderId: number;
  recipientIds: number[];
  ccIds: number[];
  private: boolean;
};

export type Person = {
  id: number;
  name: string;
  en_name: string | null;
  email: string | null;
  open_id: string | null;
  lang: string | null;
  email_notify: number;
};

export type Notice = {
  role: "recipient" | "cc" | "sender" | "broadcast";
  /** Who it's for; null for the group broadcast. */
  person: Person | null;
  sender: Person;
  lang: Lang;
  title: string;
  /** Short facts shown under the message: private, value tag, CC list. */
  details: string[];
  /** The sender's remaining allowance after a Peer Bonus (their receipt only). */
  remaining: string | null;
  post: NotifyPost;
  url: string;
};

export const nameIn = (p: { name: string; en_name: string | null }, lang: Lang) => (lang === "en" && p.en_name) || p.name;

export function buildNotices(post: NotifyPost, people: Map<number, Person>, senderRemaining?: number): Notice[] {
  const sender = people.get(post.senderId);
  if (!sender) return [];
  const bonus = post.kind === "bonus";
  const list = (ids: number[], lang: Lang) => {
    const c = copy[lang];
    const all = ids.map((id) => people.get(id)).map((p) => (p ? nameIn(p, lang) : "?"));
    return all.length <= 3 ? all.join(c.sep) : all.slice(0, 3).join(c.sep) + c.andMore(all.length);
  };
  const details = (lang: Lang, withCc: boolean) => {
    const tag = valueById(post.valueTag);
    return [
      post.private ? copy[lang].private : null,
      tag ? `# ${lang === "zh" ? tag.zh : tag.en}` : null,
      withCc && post.ccIds.length ? copy[lang].ccNote(list(post.ccIds, lang)) : null,
    ].filter((d): d is string => Boolean(d));
  };
  const base = { sender, post, url: `${config.publicUrl}/k/${post.id}`, remaining: null };
  const notices: Notice[] = [];

  for (const id of post.recipientIds) {
    const person = people.get(id);
    if (!person || id === sender.id) continue;
    const lang = langOf(person);
    const c = copy[lang];
    const title = bonus ? c.bonus(nameIn(sender, lang), post.points) : c.kudos(nameIn(sender, lang));
    notices.push({ ...base, role: "recipient", person, lang, title, details: details(lang, true) });
  }
  for (const id of post.ccIds) {
    const person = people.get(id);
    if (!person || id === sender.id) continue;
    const lang = langOf(person);
    const c = copy[lang];
    const names = list(post.recipientIds, lang);
    const title = bonus ? c.ccBonus(nameIn(sender, lang), names) : c.ccKudos(nameIn(sender, lang), names);
    notices.push({ ...base, role: "cc", person, lang, title, details: details(lang, false) });
  }
  {
    const lang = langOf(sender);
    const c = copy[lang];
    const names = list(post.recipientIds, lang);
    const title = bonus ? c.sentBonus(names, post.points, post.recipientIds.length > 1) : c.sentKudos(names);
    const remaining = bonus && senderRemaining !== undefined ? c.remaining(senderRemaining) : null;
    notices.push({ ...base, role: "sender", person: sender, lang, title, details: details(lang, true), remaining });
  }
  if (!post.private) {
    const c = copy.zh;
    const names = list(post.recipientIds, "zh");
    const title = bonus ? c.broadcastBonus(sender.name, names, post.points) : c.broadcastKudos(sender.name, names);
    notices.push({ ...base, role: "broadcast", person: null, lang: "zh", title, details: details("zh", true) });
  }
  return notices;
}

export async function loadPeople(ids: number[]) {
  const rows = await db.all<Person>(
    "SELECT id, name, en_name, email, open_id, lang, email_notify FROM users WHERE id IN (SELECT value FROM json_each($ids))",
    { ids: JSON.stringify(ids) },
  );
  return new Map(rows.map((p) => [p.id, p]));
}

export async function notifyPost(post: NotifyPost, senderRemaining?: number) {
  const lark = larkNotifyEnabled();
  const email = emailNotifyEnabled();
  if (!lark && !email) return;
  const people = await loadPeople([post.senderId, ...post.recipientIds, ...post.ccIds]);
  const notices = buildNotices(post, people, senderRemaining);
  const results = await Promise.allSettled([lark ? sendLarkNotices(notices) : null, email ? sendEmailNotices(notices) : null]);
  for (const r of results) if (r.status === "rejected") console.error("[notify]", (r.reason as Error).message);
}
