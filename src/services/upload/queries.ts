import { sql } from "../../integrations/db/index.ts";
import { type Cursor, type CursorPage, cursorPage } from "../../pagination.ts";
import type { MediaId, ProjectId, UploadId, UserId } from "../../types/id.ts";
import type { MediaKind } from "../../types/mediaItem.ts";
import type { UploadStatus } from "../../types/upload.ts";
import { accessOf } from "../project/access.ts";

export type UploadView = {
  id: UploadId;
  projectId: ProjectId;
  kind: MediaKind;
  fileName: string;
  declaredBytes: string;
  status: UploadStatus;
  createdAt: Date;
  errorCode: string | null;
  error: string | null;
  mediaId: MediaId | null;
  derive: "queued" | "running" | "done" | "failed" | null;
  uploader: {
    id: UserId;
    username: string | null;
    name: string | null;
    profileMediaId: string | null;
  };
};

type UploadListRow = Omit<UploadView, "uploader"> & {
  uploaderId: UserId;
  uploaderUsername: string | null;
  uploaderName: string | null;
  uploaderProfileMediaId: string | null;
};

const viewColumns = sql`
  u.id,
  u.project_id as "projectId",
  u.kind,
  u.file_name as "fileName",
  u.declared_bytes as "declaredBytes",
  u.status,
  u.created_at as "createdAt",
  u.error_code as "errorCode",
  u.error,
  u.media_id as "mediaId",
  j.status as "derive",
  u.uploaded_by as "uploaderId",
  pu.username as "uploaderUsername",
  pu.name as "uploaderName",
  pu.profile_media_id as "uploaderProfileMediaId"
`;

const afterClause = (after: Cursor | null) => sql`
  and (
    ${after?.at ?? null}::timestamptz is null
    or (date_trunc('milliseconds', u.created_at), u.id)
      < (${after?.at ?? null}::timestamptz, ${after?.id ?? null}::uuid)
  )
`;

export async function listUploads(
  projectId: ProjectId,
  viewerId: UserId,
  onlyUser: UserId | undefined,
  limit: number,
  after: Cursor | null,
): Promise<CursorPage<UploadView> | undefined> {
  if (!(await accessOf(projectId, viewerId))) return undefined;
  const rows = onlyUser
    ? await sql<UploadListRow[]>`
        select ${viewColumns}
        from uploads u
        join users pu on pu.id = u.uploaded_by
        left join jobs j on j.kind = 'media_derive' and j.ref = u.id
        where u.project_id = ${projectId} and u.uploaded_by = ${onlyUser}
        ${afterClause(after)}
        order by date_trunc('milliseconds', u.created_at) desc, u.id desc
        limit ${limit + 1}
      `
    : await sql<UploadListRow[]>`
        select ${viewColumns}
        from uploads u
        join users pu on pu.id = u.uploaded_by
        left join jobs j on j.kind = 'media_derive' and j.ref = u.id
        where u.project_id = ${projectId}
        ${afterClause(after)}
        order by date_trunc('milliseconds', u.created_at) desc, u.id desc
        limit ${limit + 1}
      `;
  const views = rows.map(
    ({ uploaderId, uploaderUsername, uploaderName, uploaderProfileMediaId, ...row }) => ({
      ...row,
      uploader: {
        id: uploaderId,
        username: uploaderUsername,
        name: uploaderName,
        profileMediaId: uploaderProfileMediaId,
      },
    }),
  );
  return cursorPage(views, limit, (row) => ({ at: row.createdAt, id: row.id }));
}
