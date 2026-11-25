import type { Page } from "./types/api.ts";

export type PageQuery = { limit?: number; offset?: number };

export const pageQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 200 },
    offset: { type: "integer", minimum: 0 },
  },
} as const;

export function pageOf(query: PageQuery): { limit: number; offset: number } {
  return {
    limit: Math.min(query.limit ?? 50, 200),
    offset: query.offset ?? 0,
  };
}

export function page<T>(rows: T[], limit: number, offset: number): Page<T> {
  return {
    items: rows.slice(0, limit),
    nextOffset: rows.length > limit ? offset + limit : null,
  };
}

export type CursorQuery = { limit?: number; cursor?: string };

export const cursorQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 200 },
    cursor: { type: "string", minLength: 1, maxLength: 200 },
  },
} as const;

export type Cursor = { at: Date; id: string };

export type CursorPage<T> = { items: T[]; nextCursor: string | null };

export function limitOf(limit?: number): number {
  return Math.min(limit ?? 50, 200);
}

export function decodeCursor(value: string): Cursor | undefined {
  try {
    const [at, id] = Buffer.from(value, "base64url").toString("utf8").split("|");
    if (!at || !id) return undefined;
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) return undefined;
    return { at: date, id };
  } catch {
    return undefined;
  }
}

export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`).toString("base64url");
}

export function cursorPage<T>(rows: T[], limit: number, key: (row: T) => Cursor): CursorPage<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  if (rows.length <= limit || !last) return { items, nextCursor: null };
  const cursor = key(last);
  return { items, nextCursor: encodeCursor(cursor.at, cursor.id) };
}
