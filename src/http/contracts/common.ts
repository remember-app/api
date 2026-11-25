export type ApiErrorCode =
  | "not_found"
  | "forbidden"
  | "unauthorized"
  | "bad_request"
  | "conflict"
  | "capacity_exceeded"
  | "too_long"
  | "cancelled"
  | "expired"
  | "storage_unavailable"
  | "email_unavailable"
  | "internal";

export type ApiErrorResponse = {
  error: ApiErrorCode;
  message?: string;
  details?: Record<string, unknown>;
};

export type PageResponse<T> = {
  items: T[];
  nextOffset: number | null;
};

export type CursorPageResponse<T> = {
  items: T[];
  nextCursor: string | null;
};

export type OkResponse = {
  ok: true;
};
