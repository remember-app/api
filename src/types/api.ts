export type ApiError = {
  error: ApiErrorCode;
  message?: string;
  details?: Record<string, unknown>;
};

export type ApiErrorCode =
  | "not_found"
  | "forbidden"
  | "unauthorized"
  | "bad_request"
  | "conflict"
  | "limit_exceeded"
  | "cancelled"
  | "expired"
  | "storage_unavailable"
  | "email_unavailable"
  | "internal";

export type ApiHealth = {
  status: "ok";
};

export type Page<T> = {
  items: T[];
  nextOffset: number | null;
};
