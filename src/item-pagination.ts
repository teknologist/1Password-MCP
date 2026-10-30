import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ItemOverview } from "@1password/sdk";
import { z } from "zod";

const cursorKey = randomBytes(32);
export const pageOptions = {
  tag: z.string().min(1).optional().describe("Exact, case-sensitive tag filter, applied to list metadata only."),
  pageSize: z.number().int().min(1).max(200).optional().describe("Local response page size (1-200). Does not reduce SDK fetch cost."),
  cursor: z.string().min(1).max(2048).optional().describe("Opaque nextCursor from this server process. Keep the same vault, query, tag, and limit."),
};
const payloadSchema = z.object({ offset: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), binding: z.string() }).strict();

export function pageOffset(cursor: string | undefined, context: readonly unknown[]): { offset: number; binding: string } {
  const binding = createHash("sha256").update(JSON.stringify(context)).digest("hex");
  if (!cursor) return { offset: 0, binding };
  try {
    const [encoded, signature, extra] = cursor.split(".");
    if (extra !== undefined || !encoded || !signature) throw new Error();
    const expected = createHmac("sha256", cursorKey).update(encoded).digest("base64url");
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error();
    const payload = payloadSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    if (payload.binding !== binding) throw new Error();
    return payload;
  } catch {
    throw new Error("Invalid cursor for this server, tool, vault, query, tag, or limit.");
  }
}

export function localPage(items: ItemOverview[], options: { tag?: string; pageSize?: number; cursor?: string }, position: { offset: number; binding: string }, limit?: number) {
  const tag = options.tag;
  const filtered = tag === undefined ? items : items.filter((item) => (item.tags ?? []).includes(tag));
  if (options.pageSize === undefined && options.cursor === undefined) {
    return { items: limit === undefined ? filtered : filtered.slice(0, limit) };
  }
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const sorted = [...filtered].sort((a, b) => compare(a.title, b.title) || compare(a.id, b.id));
  const bounded = limit === undefined ? sorted : sorted.slice(0, limit);
  if (position.offset > bounded.length) throw new Error("Cursor is outside the current result set. Start a new page sequence.");
  const page = bounded.slice(position.offset, position.offset + (options.pageSize ?? 50));
  const offset = position.offset + page.length;
  let nextCursor: string | null = null;
  if (offset < bounded.length) {
    const encoded = Buffer.from(JSON.stringify({ offset, binding: position.binding })).toString("base64url");
    nextCursor = `${encoded}.${createHmac("sha256", cursorKey).update(encoded).digest("base64url")}`;
  }
  return { items: page, nextCursor };
}
