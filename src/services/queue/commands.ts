import { type Db, sql } from "../../integrations/db/index.ts";
import { rank } from "../../levels.ts";
import type { AnalysisLevel } from "../../types/project.ts";

export type JobKind = "media_derive" | "media_analysis" | "montage";

export async function enqueue(
  kind: JobKind,
  ref: string,
  db: Db = sql,
  dependsOn: number[] | null = null,
  level: AnalysisLevel | null = null,
): Promise<number> {
  const [row] = await db<{ id: number }[]>`
    insert into jobs (kind, ref, depends_on, level)
    values (${kind}, ${ref}, ${dependsOn}::bigint[], ${level})
    returning id
  `;
  if (!row) throw new Error("job insert returned no row");
  return row.id;
}

export async function liveJobId(
  kind: JobKind,
  ref: string,
  db: Db = sql,
  level: AnalysisLevel | null = null,
): Promise<number | undefined> {
  const rows = await db<{ id: number; level: AnalysisLevel | null }[]>`
    select id, level from jobs
    where kind = ${kind} and ref = ${ref} and status in ('queued', 'running')
    order by id
  `;
  return rows.find((row) => level === null || rank(row.level) >= rank(level))?.id;
}

export async function cancelJobs(ref: string): Promise<number> {
  const rows = await sql`
    delete from jobs where ref = ${ref} and status in ('queued', 'running') returning id
  `;
  return rows.length;
}

export async function hasLiveJob(ref: string): Promise<boolean> {
  const rows = await sql`
    select 1 from jobs where ref = ${ref} and status in ('queued', 'running')
  `;
  return rows.length > 0;
}
