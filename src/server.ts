import "dotenv/config";
import { buildServer } from "./app";
import { env } from "./config/env";

async function start() {
  const app = buildServer();

  try {
    await app.listen({
      port: env.PORT,
      host: "0.0.0.0",
    });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void start();
