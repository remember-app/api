import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../../config.ts";
import { sendPush } from "../../integrations/push/index.ts";
import { abortUploads, deleteObjects } from "../../integrations/storage/s3.ts";
import { pageOf, pageQuerySchema } from "../../pagination.ts";
import {
  acceptInvite,
  createAppInvite,
  createProjectInvite,
  rotateProjectInvite,
} from "../../services/invite/commands.ts";
import { accessOf } from "../../services/project/access.ts";
import { createProject, deleteProject, updateProject } from "../../services/project/commands.ts";
import {
  addMember,
  removeMember,
  setContribution,
} from "../../services/project/member/commands.ts";
import { listMembers } from "../../services/project/member/queries.ts";
import { homeCards, projectTitle, projectView } from "../../services/project/queries.ts";
import { removeTokens } from "../../services/push/commands.ts";
import { inviteMessage } from "../../services/push/messages.ts";
import { tokensOfUser } from "../../services/push/queries.ts";
import type { ProjectId, ProjectItemId, UserId } from "../../types/id.ts";
import type { ProjectContributionStatus, ProjectMemberRole } from "../../types/project.ts";
import { fail } from "../errors.ts";
import { allow } from "../rate-limit.ts";

const uuidPattern = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

const projectBody = {
  type: "object",
  required: ["title", "eventStart"],
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    eventStart: { type: "string", format: "date-time" },
    eventEnd: { type: ["string", "null"], format: "date-time" },
  },
} as const;

const patchBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    eventStart: { type: "string", format: "date-time" },
    eventEnd: { type: ["string", "null"], format: "date-time" },
    coverItemId: { type: ["string", "null"] },
  },
} as const;

const memberBody = {
  type: "object",
  required: ["username", "role"],
  additionalProperties: false,
  properties: {
    username: { type: "string", minLength: 3, maxLength: 30 },
    role: { type: "string", enum: ["admin", "contributor", "viewer"] },
  },
} as const;

const contributionBody = {
  type: "object",
  required: ["status"],
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["more_coming", "done", "nothing"] },
  },
} as const;

const inviteBody = {
  type: ["object", "null"],
  additionalProperties: false,
  properties: {
    role: { type: "string", enum: ["admin", "contributor", "viewer"] },
    maxUses: { type: ["integer", "null"], minimum: 1 },
  },
} as const;

const appInviteBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    maxUses: { type: ["integer", "null"], minimum: 1 },
    expiresAt: { type: ["string", "null"], format: "date-time" },
    senderReward: {
      type: "object",
      additionalProperties: false,
      properties: {
        tokens: { type: "integer", minimum: 0 },
        storageBytes: { type: "integer", minimum: 0 },
      },
    },
    inviteeReward: {
      type: "object",
      additionalProperties: false,
      properties: {
        tokens: { type: "integer", minimum: 0 },
        storageBytes: { type: "integer", minimum: 0 },
      },
    },
  },
} as const;

const acceptBody = {
  type: "object",
  required: ["token"],
  additionalProperties: false,
  properties: { token: { type: "string", minLength: 1, maxLength: 200 } },
} as const;

type ProjectParams = { projectId: string };
async function accessOr404(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply,
) {
  const projectId = request.params.projectId;
  if (!uuidPattern.test(projectId)) {
    await fail(reply, 404, "not_found");
    return undefined;
  }
  const access = await accessOf(projectId as ProjectId, request.authenticated!.user.id);
  if (!access) {
    await fail(reply, 404, "not_found");
    return undefined;
  }
  return access;
}

export function projectRoutes(app: FastifyInstance) {
  app.post<{
    Body: { title: string; eventStart: string; eventEnd?: string | null };
  }>(
    "/projects",
    { schema: { body: projectBody }, preHandler: app.authenticate },
    async (request) => {
      const projectId = await createProject({
        title: request.body.title,
        eventStart: new Date(request.body.eventStart),
        eventEnd: request.body.eventEnd ? new Date(request.body.eventEnd) : null,
        creatorId: request.authenticated!.user.id,
      });
      return projectView(projectId, request.authenticated!.user.id);
    },
  );

  app.get<{ Querystring: { limit?: number; offset?: number } }>(
    "/projects",
    { schema: { querystring: pageQuerySchema }, preHandler: app.authenticate },
    async (request) => {
      const { limit, offset } = pageOf(request.query);
      return homeCards(request.authenticated!.user.id, limit, offset);
    },
  );

  app.get<{ Params: ProjectParams }>(
    "/projects/:projectId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      if (!(await accessOr404(request, reply))) return reply;
      const view = await projectView(
        request.params.projectId as ProjectId,
        request.authenticated!.user.id,
      );
      if (!view) return fail(reply, 404, "not_found");
      return view;
    },
  );

  app.patch<{
    Params: ProjectParams;
    Body: {
      title?: string;
      eventStart?: string;
      eventEnd?: string | null;
      coverItemId?: string | null;
    };
  }>(
    "/projects/:projectId",
    { schema: { body: patchBody }, preHandler: app.authenticate },
    async (request, reply) => {
      const body = request.body;
      const patch = {
        ...(body.title === undefined ? {} : { title: body.title }),
        ...(body.eventStart === undefined ? {} : { eventStart: new Date(body.eventStart) }),
        ...(body.eventEnd === undefined
          ? {}
          : { eventEnd: body.eventEnd === null ? null : new Date(body.eventEnd) }),
        ...(body.coverItemId === undefined
          ? {}
          : {
              coverItemId: body.coverItemId === null ? null : (body.coverItemId as ProjectItemId),
            }),
      };
      const projectId = request.params.projectId as ProjectId;
      const result = await updateProject(projectId, request.authenticated!.user.id, patch);
      if ("denial" in result) {
        return result.denial === "forbidden"
          ? fail(reply, 403, "forbidden")
          : fail(reply, 404, "not_found");
      }
      return projectView(projectId, request.authenticated!.user.id);
    },
  );

  app.delete<{ Params: { projectId: string; userId: string } }>(
    "/projects/:projectId/members/:userId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const targetId = request.params.userId;
      if (!uuidPattern.test(targetId)) return fail(reply, 404, "not_found");
      const result = await removeMember(
        request.params.projectId as ProjectId,
        request.authenticated!.user.id,
        targetId as UserId,
      );
      if ("denial" in result) {
        if (result.denial === "forbidden") return fail(reply, 403, "forbidden");
        if (result.denial === "conflict") return fail(reply, 409, "conflict");
        return fail(reply, 404, "not_found");
      }
      if (result.storageKeys.length > 0) await deleteObjects(result.storageKeys);
      return { ok: true };
    },
  );

  app.delete<{ Params: ProjectParams }>(
    "/projects/:projectId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const result = await deleteProject(
        request.params.projectId as ProjectId,
        request.authenticated!.user.id,
      );
      if ("denial" in result) {
        return result.denial === "forbidden"
          ? fail(reply, 403, "forbidden")
          : fail(reply, 404, "not_found");
      }
      if (result.deletion.multiparts.length > 0) await abortUploads(result.deletion.multiparts);
      if (result.deletion.storageKeys.length > 0) await deleteObjects(result.deletion.storageKeys);
      return { ok: true };
    },
  );

  app.get<{ Params: ProjectParams; Querystring: { limit?: number; offset?: number } }>(
    "/projects/:projectId/members",
    { schema: { querystring: pageQuerySchema }, preHandler: app.authenticate },
    async (request, reply) => {
      if (!(await accessOr404(request, reply))) return reply;
      const { limit, offset } = pageOf(request.query);
      return listMembers(request.params.projectId as ProjectId, limit, offset);
    },
  );

  app.post<{ Params: ProjectParams; Body: { username: string; role: ProjectMemberRole } }>(
    "/projects/:projectId/members",
    { schema: { body: memberBody }, preHandler: app.authenticate },
    async (request, reply) => {
      const added = await addMember(
        request.params.projectId as ProjectId,
        request.authenticated!.user.id,
        request.body.username,
        request.body.role,
      );
      if ("denial" in added) {
        if (added.denial === "forbidden") return fail(reply, 403, "forbidden");
        if (added.denial === "conflict") return fail(reply, 409, "conflict");
        return fail(reply, 404, "not_found");
      }
      const member = added.member;
      const tokens = await tokensOfUser(member.userId);
      if (tokens.length > 0) {
        const title = (await projectTitle(request.params.projectId as ProjectId)) ?? "a project";
        const message = inviteMessage(title);
        const push = await sendPush(tokens.map((entry) => ({ token: entry.token, ...message })));
        if (!push.ok) {
          request.log.warn({ status: push.status, error: push.error }, "invite push not sent");
        }
        if (push.deadTokens.length > 0) await removeTokens(push.deadTokens);
      }
      return member;
    },
  );

  app.post<{
    Params: ProjectParams;
    Body: { status: Exclude<ProjectContributionStatus, "not_started"> };
  }>(
    "/projects/:projectId/contribution",
    { schema: { body: contributionBody }, preHandler: app.authenticate },
    async (request, reply) => {
      const result = await setContribution(
        request.params.projectId as ProjectId,
        request.authenticated!.user.id,
        request.body.status,
      );
      if ("denial" in result) {
        return result.denial === "forbidden"
          ? fail(reply, 403, "forbidden")
          : fail(reply, 404, "not_found");
      }
      return { status: result.status };
    },
  );

  app.get<{ Params: ProjectParams }>(
    "/projects/:projectId/invite",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const result = await createProjectInvite({
        projectId: request.params.projectId as ProjectId,
        role: "contributor",
        createdBy: request.authenticated!.user.id,
        maxUses: null,
        expiresAt: null,
      });
      if ("denial" in result) {
        return result.denial === "forbidden"
          ? fail(reply, 403, "forbidden")
          : fail(reply, 404, "not_found");
      }
      return { token: result.invite.token, role: result.invite.role };
    },
  );

  app.post<{
    Params: ProjectParams;
    Body: { role?: ProjectMemberRole; maxUses?: number | null } | null;
  }>(
    "/projects/:projectId/invite",
    { schema: { body: inviteBody }, preHandler: app.authenticate },
    async (request, reply) => {
      if (
        !allow(
          "invites",
          request.authenticated!.user.id,
          config.rate.invites(),
          config.rate.windowMs(),
        )
      ) {
        return fail(reply, 429, "limit_exceeded");
      }
      const result = await rotateProjectInvite({
        projectId: request.params.projectId as ProjectId,
        role: request.body?.role ?? "contributor",
        createdBy: request.authenticated!.user.id,
        maxUses: request.body?.maxUses ?? null,
        expiresAt: null,
      });
      if ("denial" in result) {
        return result.denial === "forbidden"
          ? fail(reply, 403, "forbidden")
          : fail(reply, 404, "not_found");
      }
      return { token: result.invite.token, role: result.invite.role };
    },
  );

  app.post<{
    Body: {
      maxUses?: number | null;
      expiresAt?: string | null;
      senderReward?: { tokens?: number; storageBytes?: number };
      inviteeReward?: { tokens?: number; storageBytes?: number };
    };
  }>(
    "/invites/app",
    { schema: { body: appInviteBody }, preHandler: app.authenticate },
    async (request) => {
      const invite = await createAppInvite({
        createdBy: request.authenticated!.user.id,
        maxUses: request.body.maxUses ?? null,
        expiresAt: request.body.expiresAt ? new Date(request.body.expiresAt) : null,
        senderReward: {
          tokens: request.body.senderReward?.tokens ?? 0,
          storageBytes: request.body.senderReward?.storageBytes ?? 0,
        },
        inviteeReward: {
          tokens: request.body.inviteeReward?.tokens ?? 0,
          storageBytes: request.body.inviteeReward?.storageBytes ?? 0,
        },
      });
      return { token: invite.token, maxUses: invite.maxUses };
    },
  );

  app.post<{ Body: { token: string } }>(
    "/invites/accept",
    { schema: { body: acceptBody }, preHandler: app.authenticate },
    async (request, reply) => {
      const result = await acceptInvite(
        request.body.token,
        request.authenticated!.user.id as UserId,
      );
      if ("denial" in result) {
        if (result.denial === "expired") return fail(reply, 410, "not_found");
        if (result.denial === "exhausted") return fail(reply, 409, "conflict");
        return fail(reply, 404, "not_found");
      }
      if (result.invite.kind === "memory") {
        return projectView(result.invite.projectId, request.authenticated!.user.id);
      }
      return { ok: true };
    },
  );
}
