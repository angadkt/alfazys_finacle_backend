import jwt from "jsonwebtoken";
import { config } from "../config";

export function signToken(userId: string): string {
  return jwt.sign({}, config.JWT_SECRET, {
    subject: userId,
    expiresIn: `${config.SESSION_HOURS}h`,
    algorithm: "HS256",
  });
}

export function verifyToken(token: string): { userId: string } {
  const p = jwt.verify(token, config.JWT_SECRET, { algorithms: ["HS256"] });
  if (typeof p === "string" || !p.sub) throw new Error("bad token");
  return { userId: p.sub };
}
