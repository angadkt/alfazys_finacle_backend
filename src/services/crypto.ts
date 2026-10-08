import crypto from "crypto";
import { config } from "../config";

// 32-byte key is required for AES-256
// We will generate one or use the one from config. Ensure it's 32 bytes (64 hex chars or base64)
const getDocKey = () => {
  let key = config.DOC_ENCRYPTION_KEY || "";
  if (key.length === 64) return Buffer.from(key, 'hex'); // if passed as hex
  if (key.length === 32) return Buffer.from(key, 'utf8');
  // fallback for dev if missing
  return crypto.scryptSync(key || "default-secret-key-please-change", "salt", 32);
};

export function encryptDocNumber(text: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getDocKey(), iv);
  
  let encrypted = cipher.update(text, "utf8", "base64");
  encrypted += cipher.final("base64");
  
  const authTag = cipher.getAuthTag().toString("base64");
  
  return {
    doc_number_enc: `${iv.toString("base64")}:${authTag}:${encrypted}`,
    doc_number_last4: text.slice(-4).padStart(8, "*"),
    doc_number_hash: crypto.createHash("sha256").update(text).digest("hex")
  };
}

export function decryptDocNumber(encString: string) {
  const [ivB64, authTagB64, encrypted] = encString.split(":");
  if (!ivB64 || !authTagB64 || !encrypted) throw new Error("Invalid encrypted format");
  
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getDocKey(),
    Buffer.from(ivB64, "base64")
  );
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  
  let decrypted = decipher.update(encrypted, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}
