export type Module = "financial" | "flat" | "investment";
export type Level = "none" | "view" | "edit";
export type Role = "admin" | "staff" | "agent";

export const MODULES: Module[] = ["financial", "flat", "investment"];
const rank: Record<Level, number> = { none: 0, view: 1, edit: 2 };

export interface AuthUser {
  id: string;
  fullName: string;
  email: string;
  role: Role;
  permissions: Record<Module, Level>;
}

export function hasAccess(user: AuthUser, module: Module, need: Level): boolean {
  if (user.role === "admin") return true;
  return rank[user.permissions[module]] >= rank[need];
}
