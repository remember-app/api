import Fastify, { type FastifyError, type FastifyServerOptions } from "fastify";
import { identityRoutes } from "./auth/identity.ts";
import { authPlugin } from "./auth/plugin.ts";
import { socialRoutes } from "./auth/social.ts";
import { contactRoutes } from "./contacts/contacts.ts";
import { galleryRoutes } from "./media/gallery.ts";
import { labelRoutes } from "./media/labels.ts";
import { uploadRoutes } from "./media/upload.ts";
import { memberRoutes } from "./memories/members.ts";
import { memoriesPlugin } from "./memories/plugin.ts";
import { pushRoutes } from "./memories/push.ts";
import { montageRoutes } from "./montages/montages.ts";
import { musicRoutes } from "./montages/music.ts";

/**
 * The HTTP app, with no listener attached — so tests can build it and call
 * `app.inject()`. `options` exists for tests: what the service only ever writes
 * down — a push that would not send, a letter that would not go — is in the
 * log, so a test that wants to read it hands in its own log stream.
 */
export function buildApp(options: FastifyServerOptions = {}) {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test", ...options });

  // Cross-repo contract, locked by src/app.test.ts: 200, JSON, body exactly
  // {"status":"ok"}. Fastify always sends `application/json; charset=utf-8`
  // (it re-appends the charset whichever way the header is set), so clients
  // must match the content-type by prefix, not by equality.
  app.get("/health", () => ({ status: "ok" }));

  // Fastify's default handler copies `code` and `message` onto the body, so an
  // unhandled database failure would answer a stranger with its SQLSTATE and
  // the text of the failing statement. Client errors it raises itself — schema
  // validation above all — carry nothing secret and are passed through.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status < 500) return reply.code(status).send(error);
    request.log.error({ err: error }, "request failed");
    return reply.code(500).send({ error: "internal" });
  });

  // Not `app.register`: the plugin decorates the root instance so that
  // `app.authenticate` is visible to every route, in any scope. Order matters
  // — the routes below mount that decorator, so it has to exist by then.
  authPlugin(app);
  identityRoutes(app);
  socialRoutes(app);
  // Only app.authenticate: a contact list is the caller's own and knows
  // nothing about memories or membership.
  contactRoutes(app);
  // After authPlugin for the same reason: it mounts app.authenticate, and
  // it also decorates app.requireMembership for every later feature.
  memoriesPlugin(app);
  // After memoriesPlugin, not merely after authPlugin: these mount
  // app.requireMembership, which that one decorates.
  memberRoutes(app);
  uploadRoutes(app);
  galleryRoutes(app);
  // Коробки, по которым разложена та же галерея. Та же проверка членства, и
  // рядом с ней — потому что `label_ids` галереи приходят отсюда же.
  labelRoutes(app);
  pushRoutes(app);
  // Its `/memories/:memoryId/…` routes mount app.requireMembership too; the
  // internal one the montage worker knocks on mounts neither check and carries
  // its own shared secret instead.
  montageRoutes(app);
  // The organizer's own track, which a montage order may name instead of one of
  // the worker's: the same membership check, and the same upload dance the
  // media routes do. Plus the shelf's own five to listen to, which hang off no
  // memory at all and so stand behind app.authenticate alone.
  musicRoutes(app);

  return app;
}
