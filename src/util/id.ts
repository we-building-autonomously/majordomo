import { randomBytes } from "node:crypto";

/** Short, prefixed, sortable-ish ids: svc_ab12cd34. */
export function id(prefix: string): string {
  return `${prefix}_${randomBytes(5).toString("hex")}`;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "org";
}

export function nowISO(): string {
  return new Date().toISOString();
}
