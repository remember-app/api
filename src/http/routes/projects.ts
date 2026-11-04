import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  acceptInvite,
  createAppInvite,
  createProjectInvite,
  rotateProjectInvite,
} from "../../domains/invite/invite.ts";
import { accessOf, canContribute, isAdmin } from "../../domains/project/access.ts";
import {
  addMember,
  adminOf,
  listMembers,
  removeMember,
  setContribution,
} from "../../domains/project/member.ts";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  projectTitle,
  updateProject,
} from "../../domains/project/project.ts";
import { inviteMessage } from "../../domains/push/messages.ts";
import { removeTokens, tokensOfUser } from "../../domains/push/push.ts";
import { findByUsername } from "../../domains/user/user.ts";
import { sendPush } from "../../integrations/push/index.ts";
import { abortUploads, deleteObjects } from "../../integrations/storage/s3.ts";
import type { ProjectId, ProjectItemId, UserId } from "../../types/id.ts";
import type { ProjectContributionStatus, ProjectMemberRole } from "../../types/project.ts";
import { fail } from "../errors.ts";

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
      const project = await createProject({
        title: request.body.title,
        eventStart: new Date(request.body.eventStart),
        eventEnd: request.body.eventEnd ? new Date(request.body.eventEnd) : null,
        creatorId: request.authenticated!.user.id,
      });
      return project;
    },
  );

  app.get("/projects", { preHandler: app.authenticate }, async (request) => {
    return listProjects(request.authenticated!.user.id);
  });

  app.get<{ Params: ProjectParams }>(
    "/projects/:projectId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      if (!(await accessOr404(request, reply))) return reply;
      return getProject(request.params.projectId as ProjectId, request.authenticated!.user.id);
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
      const access = await accessOr404(request, reply);
      if (!access) return reply;
      if (!isAdmin(access)) return fail(reply, 403, "forbidden");
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
      const project = await updateProject(request.params.projectId as ProjectId, patch);
      if (!project) return fail(reply, 404, "not_found");
      return project;
    },
  );

  app.delete<{ Params: { projectId: string; userId: string } }>(
    "/projects/:projectId/members/:userId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const access = await accessOr404(request, reply);
      if (!access) return reply;
      const targetId = request.params.userId;
      if (!uuidPattern.test(targetId)) return fail(reply, 404, "not_found");
      const self = targetId === request.authenticated!.user.id;
      if (!self && !isAdmin(access)) return fail(reply, 403, "forbidden");
      if (self && access.role === "admin") {
        return fail(reply, 409, "conflict");
      }
      const adminId = await adminOf(request.params.projectId as ProjectId);
      if (!adminId) return fail(reply, 409, "conflict");
      const result = await removeMember(
        request.params.projectId as ProjectId,
        targetId as UserId,
        adminId,
      );
      if ("denial" in result) {
        if (result.denial === "admin") return fail(reply, 409, "conflict");
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
      const access = await accessOr404(request, reply);
      if (!access) return reply;
      if (!isAdmin(access)) return fail(reply, 403, "forbidden");
      const deleted = await deleteProject(request.params.projectId as ProjectId);
      if (!deleted) return fail(reply, 404, "not_found");
      if (deleted.multiparts.length > 0) await abortUploads(deleted.multiparts);
      if (deleted.storageKeys.length > 0) await deleteObjects(deleted.storageKeys);
      return { ok: true };
    },
  );

  app.get<{ Params: ProjectParams }>(
    "/projects/:projectId/members",
    { preHandler: app.authenticate },
    async (request, reply) => {
      if (!(await accessOr404(request, reply))) return reply;
      return listMembers(request.params.projectId as ProjectId);
    },
  );

  app.post<{ Params: ProjectParams; Body: { username: string; role: ProjectMemberRole } }>(
    "/projects/:projectId/members",
    { schema: { body: memberBody }, preHandler: app.authenticate },
    async (request, reply) => {
      const access = await accessOr404(request, reply);
      if (!access) return reply;
      if (!canContribute(access)) return fail(reply, 403, "forbidden");
      if (request.body.role === "admin" && !isAdmin(access)) {
        return fail(reply, 403, "forbidden");
      }
      const target = await findByUsername(request.body.username);
      if (!target) return fail(reply, 404, "not_found");
      const member = await addMember(
        request.params.projectId as ProjectId,
        target.id,
        request.body.role,
        request.authenticated!.user.id,
      );
      if (!member) return fail(reply, 409, "conflict");
      const tokens = await tokensOfUser(target.id);
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

  app.post<{ Params: ProjectParams; Body: { status: ProjectContributionStatus } }>(
    "/projects/:projectId/contribution",
    { schema: { body: contributionBody }, preHandler: app.authenticate },
    async (request, reply) => {
      const access = await accessOr404(request, reply);
      if (!access) return reply;
      if (access.role === "viewer") return fail(reply, 403, "forbidden");
      const contribution = await setContribution(
        request.params.projectId as ProjectId,
        request.authenticated!.user.id,
        request.body.status,
      );
      return { status: contribution };
    },
  );

  app.get<{ Params: ProjectParams }>(
    "/projects/:projectId/invite",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const access = await accessOr404(request, reply);
      if (!access) return reply;
      if (!canContribute(access)) return fail(reply, 403, "forbidden");
      const invite = await createProjectInvite({
        projectId: request.params.projectId as ProjectId,
        role: "contributor",
        createdBy: request.authenticated!.user.id,
        maxUses: null,
        expiresAt: null,
      });
      return { token: invite.token, role: invite.role };
    },
  );

  app.post<{
    Params: ProjectParams;
    Body: { role?: ProjectMemberRole; maxUses?: number | null } | null;
  }>(
    "/projects/:projectId/invite",
    { schema: { body: inviteBody }, preHandler: app.authenticate },
    async (request, reply) => {
      const access = await accessOr404(request, reply);
      if (!access) return reply;
      if (!canContribute(access)) return fail(reply, 403, "forbidden");
      const invite = await rotateProjectInvite({
        projectId: request.params.projectId as ProjectId,
        role: request.body?.role ?? "contributor",
        createdBy: request.authenticated!.user.id,
        maxUses: request.body?.maxUses ?? null,
        expiresAt: null,
      });
      return { token: invite.token, role: invite.role };
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
        return getProject(result.invite.projectId, request.authenticated!.user.id);
      }
      return { ok: true };
    },
  );
}
