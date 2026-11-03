import type { FastifyInstance } from "fastify";
import { authPlugin } from "./plugins/auth.ts";
import { authRoutes } from "./routes/auth.ts";
import { contactRoutes } from "./routes/contacts.ts";
import { labelRoutes } from "./routes/labels.ts";
import { limitRoutes } from "./routes/limits.ts";
import { meRoutes } from "./routes/me.ts";
import { mediaRoutes } from "./routes/media.ts";
import { montageRoutes } from "./routes/montages.ts";
import { movieRoutes } from "./routes/movies.ts";
import { privacyRoutes } from "./routes/privacy.ts";
import { projectRoutes } from "./routes/projects.ts";
import { pushRoutes } from "./routes/push.ts";
import { songRoutes } from "./routes/songs.ts";
import { uploadRoutes } from "./routes/uploads.ts";

export function registerRoutes(app: FastifyInstance): void {
  authPlugin(app);
  authRoutes(app);
  meRoutes(app);
  projectRoutes(app);
  mediaRoutes(app);
  uploadRoutes(app);
  labelRoutes(app);
  songRoutes(app);
  montageRoutes(app);
  movieRoutes(app);
  pushRoutes(app);
  limitRoutes(app);
  contactRoutes(app);
  privacyRoutes(app);
}
