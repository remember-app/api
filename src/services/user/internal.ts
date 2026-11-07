import { sql } from "../../integrations/db/index.ts";

export const userColumns = sql`id, username, name, email, language, registered, profile_media_id as "profileMediaId"`;
export const publicColumns = sql`id, username, name, profile_media_id as "profileMediaId"`;

const usernamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,28}[a-zA-Z0-9]$/;

export const isValidUsername = (username: string) => usernamePattern.test(username);
