import type { FastifyReply } from "fastify";
import type { ApiErrorCode } from "./contracts/common.ts";

export function fail(reply: FastifyReply, status: number, error: ApiErrorCode, details?: unknown) {
  return reply.code(status).send(details === undefined ? { error } : { error, details });
}

export function codeForStatus(status: number): ApiErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404 || status === 410) return "not_found";
  if (status === 409) return "conflict";
  if (status === 413 || status === 429) return "capacity_exceeded";
  if (status === 503) return "storage_unavailable";
  if (status >= 400 && status < 500) return "bad_request";
  return "internal";
}
