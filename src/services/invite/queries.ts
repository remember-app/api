import { sql } from "../../integrations/db/index.ts";
import type { ProjectId } from "../../types/id.ts";
import type { InviteProject } from "../../types/invite.ts";
import { columns, type InviteRow, toInvite } from "./internal.ts";

export async function liveProjectInvite(projectId: ProjectId): Promise<InviteProject | undefined> {
  const [row] = await sql<InviteRow[]>`
    select ${columns}
    from invites
    where project_id = ${projectId} and kind = 'memory' and revoked_at is null
  `;
  return row && (toInvite(row) as InviteProject);
}
