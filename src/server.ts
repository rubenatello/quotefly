import "dotenv/config";
import { buildServer } from "./app";
import { env } from "./config/env";
import { installGracefulApiShutdown } from "./lib/graceful-shutdown";

async function start() {
  const app = buildServer();
  installGracefulApiShutdown({
    close: () => app.close(),
    logger: app.log,
  });

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
