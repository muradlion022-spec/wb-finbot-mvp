import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { app } from "./routes.js";
import { startBot } from "./bot.js";

const server = serve(
  {
    fetch: app.fetch,
    port: config.API_PORT,
    hostname: "127.0.0.1"
  },
  (info) => {
    console.log(`API is running on http://127.0.0.1:${info.port}`);
  }
);

const bot = startBot();

async function shutdown() {
  server.close();
  bot?.stop();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
