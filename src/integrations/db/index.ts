import postgres from "postgres";
import { config } from "../../config.ts";

export const sql = postgres(config.postgres.url());
