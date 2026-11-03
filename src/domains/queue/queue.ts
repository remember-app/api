import { sql } from "../../integrations/db/index.ts";

export type JobKind = "media_derive" | "montage";

export async function enqueue(kind: JobKind, ref: string): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    insert into jobs (kind, ref) values (${kind}, ${ref}) returning id
  `;
  if (!row) throw new Error("job insert returned no row");
  return row.id;
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
