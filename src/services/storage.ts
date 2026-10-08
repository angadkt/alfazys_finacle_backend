import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { config } from "../config";

export interface StorageService {
  saveFile(buffer: Buffer, originalExt: string): Promise<string>;
  getFile(key: string): Promise<Buffer>;
}

export const localDiskStorage: StorageService = {
  async saveFile(buffer: Buffer, originalExt: string) {
    const dir = config.UPLOAD_DIR || "./uploads";
    await fs.mkdir(dir, { recursive: true });

    const key = crypto.randomBytes(16).toString("hex") + (originalExt ? `.${originalExt}` : "");
    const filePath = path.join(dir, key);
    
    await fs.writeFile(filePath, buffer);
    return key;
  },
  async getFile(key: string) {
    const dir = config.UPLOAD_DIR || "./uploads";
    const filePath = path.join(dir, key);
    return fs.readFile(filePath);
  }
};
