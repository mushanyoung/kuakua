import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

async function compose(page: Page, kind: "kudos" | "bonus" = "kudos") {
  await page.goto("/");
  await page
    .locator(".hero-actions")
    .getByRole("button", { name: kind === "bonus" ? "Peer Bonus" : "送出一份感谢", exact: true })
    .click();
}
async function recipient(page: Page, name: string) {
  const input = page.getByRole("combobox", { name: "夸谁" });
  await input.fill(name);
  await expect(page.getByRole("option").filter({ hasText: name })).toBeVisible();
  await input.press("Enter");
}

test("send kudos with keyboard, open a deep link, react, comment and delete", async ({ page }) => {
  await compose(page);
  await expect(page.getByRole("dialog", { name: "送出一份感谢" })).toBeVisible();
  await recipient(page, "bob");
  await page.getByLabel("想说的话").fill("谢谢 bob 帮我们完成项目验收");
  await page.getByRole("button", { name: "送出感谢", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const card = page.locator("article.post").filter({ hasText: "谢谢 bob 帮我们完成项目验收" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "+1", exact: true }).click();
  await expect(card.locator(".reaction.mine")).toContainText("+1");
  await card.locator('a[href^="/k/"]').click();
  await expect(page).toHaveURL(/\/k\/\d+$/);
  await page.reload();
  await expect(page.locator("article.post")).toContainText("谢谢 bob 帮我们完成项目验收");
  await page.getByPlaceholder("说点什么，附和一下…").fill("一起把事情做好！");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".comment")).toContainText("一起把事情做好！");
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.locator(".menu-pop").getByRole("button", { name: "删除", exact: true }).click();
  await page.goto("/");
  await expect(page.locator("article.post")).toHaveCount(0);
});

test("bonus validates message length, spends allowance and refunds after delete", async ({ page }) => {
  await compose(page, "bonus");
  await recipient(page, "bob");
  await page.getByLabel("想说的话").fill("太棒了");
  await page.getByRole("button", { name: "送出感谢", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Peer Bonus 请至少写 10 个字");
  await expect(page.locator("article.post")).toHaveCount(0);
  await page.getByLabel("想说的话").fill("感谢你认真帮助团队一起完成了这个项目");
  await page.getByRole("button", { name: "送出感谢", exact: true }).click();
  await expect(page.locator("article.post")).toBeVisible();
  await compose(page, "bonus");
  await expect(page.getByRole("dialog")).toContainText("本月剩余 1");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.locator(".menu-pop").getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.locator("article.post")).toHaveCount(0);
  await compose(page, "bonus");
  await expect(page.getByRole("dialog")).toContainText("本月剩余 2");
});

test("private kudos reaches recipient and CC but stays hidden from another colleague", async ({ page, context }) => {
  await compose(page);
  await recipient(page, "bob");
  const cc = page.getByRole("combobox", { name: /抄送/ });
  await cc.fill("carol");
  await cc.press("Enter");
  await page.getByLabel("想说的话").fill("这是只给相关同事的私密感谢");
  await page.getByText("秘密夸", { exact: true }).click();
  await expect(page.getByRole("checkbox", { name: /秘密夸/ })).toBeChecked();
  await page.getByRole("button", { name: "送出感谢", exact: true }).click();
  const card = page.locator("article.post");
  await expect(card).toContainText("这是只给相关同事的私密感谢");
  const href = await card.locator('a[href^="/k/"]').getAttribute("href");
  expect(href).toBeTruthy();
  if (!href) throw new Error("Post link missing");
  for (const user of ["bob", "carol"]) {
    await context.setExtraHTTPHeaders({ "X-Dev-Email": `${user}@example.com` });
    await page.goto(href);
    await expect(page.locator("article.post")).toContainText("这是只给相关同事的私密感谢");
  }
  await context.setExtraHTTPHeaders({ "X-Dev-Email": "outsider@example.com" });
  await page.goto(href);
  await expect(page.locator("article.post")).toHaveCount(0);
  await expect(page.getByText("这条感谢不存在，或者仅相关的人可见")).toBeVisible();
  await page.goto("/");
  await expect(page.locator("article.post")).toHaveCount(0);
});

test("profile and navigation avatar sizes remain bounded on own and colleague profiles", async ({ page, isMobile }) => {
  for (const id of [2, 3]) {
    await page.goto(`/u/${id}`);
    const avatar = page.locator(".profile-avatar");
    await expect(avatar).toBeVisible();
    await avatar.locator("img").evaluate((img: HTMLImageElement) => img.decode());
    const profileSize = isMobile ? "104px" : "132px";
    await expect(avatar).toHaveCSS("width", profileSize);
    await expect(avatar).toHaveCSS("height", profileSize);
    await expect(page.locator(".profile-id h1")).toBeInViewport();

    const navigationAvatar = page.locator(isMobile ? ".tabbar .avatar" : ".nav-me .avatar");
    const navigationSize = isMobile ? "24px" : "34px";
    await expect(navigationAvatar).toBeVisible();
    await expect(navigationAvatar).toHaveCSS("width", navigationSize);
    await expect(navigationAvatar).toHaveCSS("height", navigationSize);

    if (id === 2 && !isMobile) {
      const allowance = page.locator(".allowance .ring-wrap svg");
      await expect(allowance).toHaveCSS("width", "88px");
      await expect(allowance).toHaveCSS("height", "88px");
    }
  }
});

test("profile avatar upload and restore persist; language preference survives reload", async ({ page }) => {
  await page.goto("/u/2");
  const avatar = page.locator(".profile-avatar img");
  const original = await avatar.getAttribute("src");
  await page.getByLabel("更换头像", { exact: true }).setInputFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"),
  });
  await expect(page.getByRole("button", { name: "恢复原头像", exact: true })).toBeVisible();
  await expect(avatar).not.toHaveAttribute("src", original ?? "");
  await page.reload();
  await page.getByRole("button", { name: "恢复原头像", exact: true }).click();
  await expect(avatar).toHaveAttribute("src", original ?? "");
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("button", { name: "Change avatar", exact: true })).toBeVisible();
});

test("admin can export bonus CSV; ordinary colleagues cannot open admin tools", async ({ page, context }) => {
  await compose(page, "bonus");
  await recipient(page, "bob");
  await page.getByLabel("想说的话").fill("感谢你认真帮助团队一起完成了这个项目");
  await page.getByRole("button", { name: "送出感谢", exact: true }).click();
  await expect(page.locator("article.post")).toBeVisible();
  await page.goto("/admin");
  await expect(page.getByRole("link", { name: "下载 CSV" })).toHaveCount(0);
  await context.setExtraHTTPHeaders({ "X-Dev-Email": "admin@example.com" });
  await page.goto("/admin");
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "下载 CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.csv$/);
  const stream = await file.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString("utf8")).toContain("bob@example.com");
});
