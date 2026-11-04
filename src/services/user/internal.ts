import { sql } from "../../integrations/db/index.ts";

export const userColumns = sql`id, username, name, email`;
export const publicColumns = sql`id, username, name`;

const usernamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,28}[a-zA-Z0-9]$/;

export const isValidUsername = (username: string) => usernamePattern.test(username);
