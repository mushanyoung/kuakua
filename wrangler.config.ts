import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({
  assetsDirectory: "./dist",
  minify: true,
  types: { generate: false },
  dev: { ip: "127.0.0.1", port: 4381 },
});
