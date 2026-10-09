import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { config } from "../src/config";

// Usage: npm run db:restore [path_to_backup_file] [optional_target_db_url]
async function main() {
  const backupDir = path.join(__dirname, "..", "backups");
  let fileArg = process.argv[2];
  const targetDbUrl = process.argv[3] || process.env.DATABASE_URL || config.DATABASE_URL;

  if (!fileArg) {
    // If no file specified, pick the latest backup in backups/
    if (fs.existsSync(backupDir)) {
      const files = fs
        .readdirSync(backupDir)
        .filter((f) => f.endsWith(".sql"))
        .sort()
        .reverse();
      if (files.length > 0) {
        fileArg = path.join(backupDir, files[0]);
        console.log(`ℹ️  No file specified. Using most recent backup: ${files[0]}`);
      }
    }
  }

  if (!fileArg || !fs.existsSync(fileArg)) {
    console.error("❌ Error: Backup file not found. Provide a valid backup file path.");
    console.log("Usage: npm run db:restore ./backups/infazys_backup_xxx.sql [TARGET_DATABASE_URL]");
    process.exit(1);
  }

  if (!targetDbUrl) {
    console.error("❌ Error: Target DATABASE_URL is not set.");
    process.exit(1);
  }

  console.log(`🔄 Starting database restoration...`);
  console.log(`📁 Source: ${fileArg}`);

  // Test if psql is available
  let psqlCmd = "psql";
  const commonWinPaths = [
    "C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe",
    "C:\\Program Files\\PostgreSQL\\15\\bin\\psql.exe",
    "C:\\Program Files\\PostgreSQL\\14\\bin\\psql.exe",
  ];

  try {
    execSync("psql --version", { stdio: "ignore" });
  } catch {
    const foundPath = commonWinPaths.find((p) => fs.existsSync(p));
    if (foundPath) {
      psqlCmd = `"${foundPath}"`;
    } else {
      console.warn("⚠️  'psql' command not found in PATH.");
      console.warn("   You can restore manually using:");
      console.warn(`   psql "${targetDbUrl}" -f "${fileArg}"`);
      process.exit(1);
    }
  }

  try {
    const cmd = `${psqlCmd} "${targetDbUrl}" -f "${fileArg}"`;
    execSync(cmd, { stdio: "inherit" });
    console.log(`✅ Database successfully restored from ${fileArg}!`);
  } catch (err: any) {
    console.error("❌ Restore failed:", err.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
