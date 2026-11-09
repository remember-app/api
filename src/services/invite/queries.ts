import { sql } from "../../integrations/db/index.ts";
import type { ProjectId, UserId } from "../../types/id.ts";
import type { InviteApp, InviteProject } from "../../types/invite.ts";
import { columns, type InviteRow, toInvite } from "./internal.ts";

export async function liveProjectInvite(projectId: ProjectId): Promise<InviteProject | undefined> {
  const [row] = await sql<InviteRow[]>`
    select ${columns}
    from invites
    where project_id = ${projectId} and kind = 'memory' and revoked_at is null
  `;
  return row && (toInvite(row) as InviteProject);
}

export async function liveAppInvite(userId: UserId): Promise<InviteApp | undefined> {
  const [row] = await sql<InviteRow[]>`
    select ${columns}
    from invites
    where created_by = ${userId} and kind = 'app' and revoked_at is null
  `;
  return row && (toInvite(row) as InviteApp);
}
