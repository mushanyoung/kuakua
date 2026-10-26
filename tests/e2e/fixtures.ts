import { test as base, expect } from "@playwright/test";
import { type App, createApp, resetApp } from "../support/app.ts";

export const test = base.extend<{ app: App }, { serverApp: App }>({
  serverApp: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructuring to discover fixture dependencies; this fixture has none.
    async ({}, use) => {
      const app = await createApp();
      try {
        await use(app);
      } finally {
        await app.server.close();
      }
    },
    { scope: "worker" },
  ],
  app: [
    async ({ serverApp }, use, testInfo) => {
      await resetApp(serverApp);
      try {
        await use(serverApp);
      } finally {
        if (testInfo.status !== testInfo.expectedStatus) {
          await testInfo.attach("worker-logs", {
            body: JSON.stringify(serverApp.server.getLogs(), null, 2),
            contentType: "application/json",
          });
        }
      }
    },
    { auto: true },
  ],
  baseURL: async ({ serverApp }, use) => {
    await use(serverApp.url);
  },
  page: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await use(page);
    expect(errors, "uncaught browser errors").toEqual([]);
  },
});
export { expect };
