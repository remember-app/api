import { sql } from "../../integrations/db/index.ts";
import { page } from "../../pagination.ts";
import type { Page } from "../../types/api.ts";
import type { MediaId, MovieId, ProjectId } from "../../types/id.ts";
import type { Movie } from "../../types/movie.ts";
import { deleteMediaRows } from "../media/commands.ts";

const columns = sql`
  id,
  name,
  project_id as "projectId",
  created_by as "createdBy",
  created_at as "createdAt",
  montage_id as "montageId",
  original_id as "originalId",
  compressed_id as "compressedId",
  preview_id as "previewId"
`;

export async function getMovie(id: MovieId): Promise<Movie | undefined> {
  const [row] = await sql<Movie[]>`select ${columns} from movies where id = ${id}`;
  return row;
}

export async function listMovies(
  projectId: ProjectId,
  limit: number,
  offset: number,
): Promise<Page<Movie>> {
  const rows = await sql<Movie[]>`
    select ${columns}
    from movies
    where project_id = ${projectId}
    order by created_at desc
    limit ${limit + 1} offset ${offset}
  `;
  return page(rows, limit, offset);
}

export type NewMovie = Movie;

export async function createMovie(input: NewMovie): Promise<Movie> {
  const [row] = await sql<Movie[]>`
    insert into movies (
      id, name, project_id, created_by, montage_id, original_id, compressed_id, preview_id
    )
    values (
      ${input.id}, ${input.name}, ${input.projectId}, ${input.createdBy}, ${input.montageId},
      ${input.originalId}, ${input.compressedId}, ${input.previewId}
    )
    returning ${columns}
  `;
  if (!row) throw new Error("movie insert returned no row");
  return row;
}

export async function renameMovie(
  id: MovieId,
  projectId: ProjectId,
  name: string,
): Promise<Movie | undefined> {
  const [row] = await sql<Movie[]>`
    update movies
    set name = ${name}
    where id = ${id} and project_id = ${projectId}
    returning ${columns}
  `;
  return row;
}

export async function deleteMovieWithMedia(
  id: MovieId,
  projectId: ProjectId,
): Promise<string[] | undefined> {
  return sql.begin(async (tx) => {
    const [row] = await tx<Movie[]>`
      delete from movies
      where id = ${id} and project_id = ${projectId}
      returning ${columns}
    `;
    if (!row) return undefined;
    const ids = [row.originalId, row.compressedId, row.previewId].filter(
      (mediaId): mediaId is MediaId => mediaId !== null,
    );
    return deleteMediaRows(ids, tx);
  });
}
