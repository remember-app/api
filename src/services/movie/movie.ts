import { sql } from "../../integrations/db/index.ts";
import { page } from "../../pagination.ts";
import type { Page } from "../../types/api.ts";
import type { MediaId, MontageId, MovieId, ProjectId, UserId } from "../../types/id.ts";
import type { Movie } from "../../types/movie.ts";
import { deleteMediaRows } from "../media/commands.ts";

const columns = sql`
  id,
  name,
  project_id as "projectId",
  created_by as "createdBy",
  created_at as "createdAt",
  montage_id as "montageId",
  video_id as "videoId",
  thumbnail_id as "thumbnailId",
  preview_id as "previewId"
`;

type MovieRow = {
  id: MovieId;
  name: string;
  projectId: ProjectId;
  createdBy: UserId;
  createdAt: Date;
  montageId: MontageId;
  videoId: MediaId;
  thumbnailId: MediaId | null;
  previewId: MediaId | null;
};

const toMovie = ({ thumbnailId, previewId, ...rest }: MovieRow): Movie => ({
  ...rest,
  derived: { thumbnailId, previewId },
});

export async function getMovie(id: MovieId): Promise<Movie | undefined> {
  const [row] = await sql<MovieRow[]>`select ${columns} from movies where id = ${id}`;
  return row && toMovie(row);
}

export async function listMovies(
  projectId: ProjectId,
  limit: number,
  offset: number,
): Promise<Page<Movie>> {
  const rows = await sql<MovieRow[]>`
    select ${columns}
    from movies
    where project_id = ${projectId}
    order by created_at desc
    limit ${limit + 1} offset ${offset}
  `;
  return page(rows.map(toMovie), limit, offset);
}

export type NewMovie = {
  name: string;
  projectId: ProjectId;
  createdBy: UserId;
  montageId: MontageId;
  videoId: MediaId;
  thumbnailId: MediaId | null;
  previewId: MediaId | null;
};

export async function createMovie(input: NewMovie): Promise<Movie> {
  const [row] = await sql<MovieRow[]>`
    insert into movies (
      name, project_id, created_by, montage_id, video_id, thumbnail_id, preview_id
    )
    values (
      ${input.name},
      ${input.projectId},
      ${input.createdBy},
      ${input.montageId},
      ${input.videoId},
      ${input.thumbnailId},
      ${input.previewId}
    )
    returning ${columns}
  `;
  if (!row) throw new Error("movie insert returned no row");
  return toMovie(row);
}

export async function setMovieDerived(
  id: MovieId,
  thumbnailId: MediaId | null,
  previewId: MediaId | null,
): Promise<Movie | undefined> {
  const [row] = await sql<MovieRow[]>`
    update movies
    set thumbnail_id = ${thumbnailId}, preview_id = ${previewId}
    where id = ${id}
    returning ${columns}
  `;
  return row && toMovie(row);
}

export async function renameMovie(
  id: MovieId,
  projectId: ProjectId,
  name: string,
): Promise<Movie | undefined> {
  const [row] = await sql<MovieRow[]>`
    update movies
    set name = ${name}
    where id = ${id} and project_id = ${projectId}
    returning ${columns}
  `;
  return row && toMovie(row);
}

export async function deleteMovieWithMedia(
  id: MovieId,
  projectId: ProjectId,
): Promise<string[] | undefined> {
  return sql.begin(async (tx) => {
    const [row] = await tx<MovieRow[]>`
      delete from movies
      where id = ${id} and project_id = ${projectId}
      returning ${columns}
    `;
    if (!row) return undefined;
    const ids = [row.videoId, row.thumbnailId, row.previewId].filter(
      (mediaId): mediaId is MediaId => mediaId !== null,
    );
    return deleteMediaRows(ids, tx);
  });
}
