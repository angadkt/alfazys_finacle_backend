import { hashPassword } from "../src/auth/password";
import { MODULES } from "../src/auth/permissions";
import { pool, tx } from "../src/db";

// Creates the first super admin.
// Usage: ADMIN_EMAIL=a@b.com ADMIN_NAME="Owner" ADMIN_PASSWORD='long-password' npm run seed:admin
async function main() {
  const { ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_NAME || !ADMIN_PASSWORD) throw new Error("Set ADMIN_EMAIL, ADMIN_NAME and ADMIN_PASSWORD");
  if (ADMIN_PASSWORD.length < 10) throw new Error("Password must be at least 10 characters");
  await tx(async (c) => {
    const { rows } = await c.query(
      "INSERT INTO users (full_name, email, password_hash, role) VALUES ($1, $2, $3, 'admin') RETURNING id",
      [ADMIN_NAME, ADMIN_EMAIL.toLowerCase(), await hashPassword(ADMIN_PASSWORD)]);
    for (const m of MODULES) {
      await c.query("INSERT INTO user_permissions (user_id, module, level) VALUES ($1, $2, 'edit')", [rows[0].id, m]);
    }
  });
  console.log("Super admin created.");
  await pool.end();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
