import { readFileSync } from "fs";
import { join } from "path";
import { pool } from "../src/db";

// Creates all tables from db/schema.sql. Does nothing if they already exist.
async function main() {
  const exists = await pool.query("SELECT to_regclass('public.users') AS t");
  if (exists.rows[0].t) {
    console.log("Tables already exist. Nothing to do.");
  } else {
    await pool.query(readFileSync(join(__dirname, "..", "db", "schema.sql"), "utf8"));
    console.log("Database created.");
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
