import { app } from "./app";
import { config } from "./config";
import { pool } from "./db";

const server = app.listen(config.PORT, () => {
  console.log(`API running on port ${config.PORT}`);
});

async function stop() {
  server.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
