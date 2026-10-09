import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { config } from "../src/config";

// Usage: npm run db:backup [optional_db_url]
async function main() {
  const dbUrl = process.argv[2] || process.env.DATABASE_URL || config.DATABASE_URL;

  if (!dbUrl) {
    console.error("❌ Error: No DATABASE_URL provided. Please set DATABASE_URL or pass it as an argument.");
    process.exit(1);
  }

  const backupDir = path.join(__dirname, "..", "backups");
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `infazys_backup_${timestamp}.sql`;
  const targetPath = path.join(backupDir, filename);

  console.log(`📦 Starting database backup...`);
  console.log(`📁 Target: ${targetPath}`);

  // Test if pg_dump is available
  let pgDumpCmd = "pg_dump";
  const commonWinPaths = [
    "C:\\Program Files\\PostgreSQL\\16\\bin\\pg_dump.exe",
    "C:\\Program Files\\PostgreSQL\\15\\bin\\pg_dump.exe",
    "C:\\Program Files\\PostgreSQL\\14\\bin\\pg_dump.exe",
  ];

  try {
    execSync("pg_dump --version", { stdio: "ignore" });
  } catch {
    const foundPath = commonWinPaths.find((p) => fs.existsSync(p));
    if (foundPath) {
      pgDumpCmd = `"${foundPath}"`;
    } else {
      console.warn("⚠️  'pg_dump' command not found in PATH.");
      console.warn("   If you have PostgreSQL installed, ensure its bin folder is in your system PATH.");
      console.warn("   Alternatively, you can run pg_dump directly using:");
      console.warn(`   pg_dump "${dbUrl}" --clean --if-exists --no-owner --no-privileges -f "${targetPath}"`);
      process.exit(1);
    }
  }

  try {
    // --clean --if-exists: drops tables before recreating, ideal for restore into empty or existing DB
    // --no-owner --no-privileges: makes the dump portable between different cloud DB users (Render vs AWS RDS)
    const cmd = `${pgDumpCmd} "${dbUrl}" --clean --if-exists --no-owner --no-privileges -f "${targetPath}"`;
    execSync(cmd, { stdio: "inherit" });

    const stats = fs.statSync(targetPath);
    console.log(`✅ Backup successful!`);
    console.log(`📄 File: ${filename}`);
    console.log(`📊 Size: ${(stats.size / 1024).toFixed(2)} KB`);
  } catch (err: any) {
    console.error("❌ Backup failed:", err.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
