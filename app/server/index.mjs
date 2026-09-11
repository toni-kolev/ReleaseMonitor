import { resolve } from "node:path";
import { createStore } from "./store.mjs";
import { createGithub } from "./github.mjs";
import { createCodeberg } from "./codeberg.mjs";
import { createApp } from "./app.mjs";

const intervalMinutes = Number(process.env.SYNC_INTERVAL_MINUTES || 60);
if (!Number.isFinite(intervalMinutes) || intervalMinutes < 5)
  throw new Error("SYNC_INTERVAL_MINUTES must be at least 5.");
const store = createStore(
  resolve(process.env.DATA_DIR || "data", "feed.sqlite"),
);
const github = createGithub({ token: process.env.GITHUB_TOKEN });
const codeberg = createCodeberg({ token: process.env.CODEBERG_TOKEN });
const { app, syncAll } = createApp({ store, github, codeberg, intervalMinutes });
const server = app.listen(Number(process.env.PORT || 3000), "0.0.0.0", () => {
  console.log(`ReleaseMonitor listening on port ${process.env.PORT || 3000}`);
  void syncAll();
});
const timer = setInterval(() => void syncAll(), intervalMinutes * 60000);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    clearInterval(timer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  });
