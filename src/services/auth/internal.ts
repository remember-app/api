import { createHash, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";
import { sql } from "../../integrations/db/index.ts";

const scrypt = promisify(scryptCallback);

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export const hashToken = (token: string) => createHash("sha256").update(token).digest();

export const codeHash = (code: string, salt: Buffer) => scrypt(code, salt, 32) as Promise<Buffer>;

export const sessionColumns = sql`
  id,
  user_id as "userId",
  created_at as "createdAt",
  expires_at as "expiresAt",
  revoked_at as "revokedAt"
`;
