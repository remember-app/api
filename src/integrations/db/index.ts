import postgres, { type Sql, type TransactionSql } from "postgres";
import { config } from "../../config.ts";

export const sql = postgres(config.postgres.url());

export type Db = Sql | TransactionSql;
