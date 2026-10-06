import { env } from "cloudflare:workers";
import { config } from "./config";
import { copy, nameIn, site, type Lang, type Notice } from "./notify";

// Notification emails through Cloudflare Email Service (the EMAIL send_email binding, only
// configured when EMAIL_NOTIFY=1). One email per person thanked or CC'd, in their language;
// replying reaches the sender. People can switch them off on their profile (users.email_notify).

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function mailer() {
  if (!("EMAIL" in env)) throw new Error("EMAIL binding missing: set EMAIL_NOTIFY=1 and redeploy");
  return env.EMAIL;
}

const from = () => ({ email: config.email.from, name: config.email.fromName });

function layout(lang: Lang, body: string) {
  const c = copy[lang];
  return `<!doctype html><html lang="${lang === "zh" ? "zh-CN" : "en"}"><body style="margin:0;padding:0;background:#f6f3f7">
<div style="max-width:560px;margin:0 auto;padding:28px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;color:#1b0e18">
<div style="font-size:13px;font-weight:700;color:#ff6b8b;letter-spacing:.04em;margin-bottom:14px">❤ 夸夸</div>
<div style="background:#ffffff;border-radius:18px;padding:24px 24px 22px;border:1px solid #efe7ef">${body}</div>
<p style="font-size:12px;line-height:1.6;color:#8d849b;margin:16px 4px 0">${esc(site())} · <a href="${esc(`${config.publicUrl}/u/me`)}" style="color:#8d849b">${esc(c.optOut)}</a></p>
</div></body></html>`;
}

function button(href: string, label: string) {
  return `<a href="${esc(href)}" style="display:inline-block;margin-top:18px;padding:10px 20px;border-radius:999px;background:#ff6b8b;color:#ffffff;font-weight:600;font-size:14px;text-decoration:none">${esc(label)}</a>`;
}

function render(n: Notice) {
  const c = copy[n.lang];
  const sender = nameIn(n.sender, n.lang);
  const accent = n.post.kind === "bonus" ? "#ff9f6b" : "#ff6b8b";
  const html = layout(
    n.lang,
    `<h1 style="font-size:19px;line-height:1.4;margin:0 0 16px">${esc(n.title)}</h1>
<div style="margin:0;padding:12px 16px;border-left:4px solid ${accent};background:#fff6f8;border-radius:6px;font-size:16px;line-height:1.75;white-space:pre-wrap">${esc(n.post.message)}</div>
${n.details.length ? `<p style="font-size:13px;color:#6b6175;margin:12px 0 0">${n.details.map(esc).join(" · ")}</p>` : ""}
${button(n.url, c.open)}
${n.sender.email ? `<p style="font-size:13px;color:#8d849b;margin:18px 0 0">${esc(c.replyHint(sender))}</p>` : ""}`,
  );
  const text = [
    n.title,
    "",
    `“${n.post.message}”`,
    ...(n.details.length ? ["", n.details.join(" · ")] : []),
    "",
    `${c.open}: ${n.url}`,
    ...(n.sender.email ? ["", c.replyHint(sender)] : []),
    "",
    "--",
    `${site()} · ${c.optOut}: ${config.publicUrl}/u/me`,
  ].join("\n");
  return { html, text };
}

export async function sendEmailNotices(notices: Notice[]) {
  const mail = mailer();
  const targets = notices.filter(
    (n) => (n.role === "recipient" || n.role === "cc") && n.person?.email && n.person.email_notify === 1,
  );
  const results = await Promise.allSettled(
    targets.map((n) =>
      mail.send({
        to: n.person!.email!,
        from: from(),
        ...(n.sender.email ? { replyTo: { email: n.sender.email, name: nameIn(n.sender, n.lang) } } : {}),
        subject: n.title,
        ...render(n),
      }),
    ),
  );
  results.forEach((r, i) => {
    if (r.status === "rejected") console.error("[email]", targets[i]!.person!.email, (r.reason as Error).message);
  });
}

// Admin page: proves the sending domain and binding work without posting anything.
export async function sendTestEmail(to: string, lang: Lang) {
  const c = copy[lang];
  const html = layout(
    lang,
    `<h1 style="font-size:19px;margin:0 0 12px">${esc(c.testSubject)}</h1>
<p style="font-size:15px;line-height:1.7;margin:0">${esc(c.testBody(config.email.from))}</p>${button(config.publicUrl, c.open)}`,
  );
  const result = await mailer().send({ to, from: from(), subject: c.testSubject, html, text: `${c.testBody(config.email.from)}\n\n${config.publicUrl}` });
  return result.messageId;
}
