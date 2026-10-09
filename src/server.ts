import fs from "fs";
import path from "path";
import { app } from "./app";
import { hashPassword } from "./auth/password";
import { MODULES } from "./auth/permissions";
import { config } from "./config";
import { pool, tx } from "./db";

async function initDatabase() {
  try {
    const exists = await pool.query("SELECT to_regclass('public.users') AS t");
    if (!exists.rows[0].t) {
      console.log("📦 Empty database detected. Running db/schema.sql...");
      const schemaPath = path.join(process.cwd(), "db", "schema.sql");
      if (fs.existsSync(schemaPath)) {
        const sql = fs.readFileSync(schemaPath, "utf8");
        await pool.query(sql);
        console.log("✅ Database tables created successfully.");
      } else {
        console.warn(`⚠️ Schema file not found at ${schemaPath}`);
      }
    }

    // Auto-seed default admin if no admin account exists yet
    const usersTable = await pool.query("SELECT to_regclass('public.users') AS t");
    if (usersTable.rows[0].t) {
      const adminCheck = await pool.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
      if (adminCheck.rows.length === 0) {
        console.log("👤 Creating initial admin account...");
        const adminEmail = (process.env.ADMIN_EMAIL || "admin@admin.com").toLowerCase();
        const adminPass = process.env.ADMIN_PASSWORD || "adminPassword123!";
        const adminName = process.env.ADMIN_NAME || "Super Admin";

        await tx(async (c) => {
          const { rows } = await c.query(
            "INSERT INTO users (full_name, email, password_hash, role) VALUES ($1, $2, $3, 'admin') RETURNING id",
            [adminName, adminEmail, await hashPassword(adminPass)],
          );
          for (const m of MODULES) {
            await c.query(
              "INSERT INTO user_permissions (user_id, module, level) VALUES ($1, $2, 'edit') ON CONFLICT DO NOTHING",
              [rows[0].id, m],
            );
          }
        });
        console.log(`✅ Default admin account ready: ${adminEmail}`);
      }
    }
  } catch (err: any) {
    console.error("❌ Database initialization notice:", err.message);
  }
}

async function start() {
  await initDatabase();

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
}

start().catch((err) => {
  console.error("Server startup error:", err);
  process.exit(1);
});
