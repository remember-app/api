import type { FastifyInstance } from "fastify";
import { authPlugin } from "./plugins/auth.ts";
import { authRoutes } from "./routes/auth.ts";
import { contactRoutes } from "./routes/contacts.ts";
import { labelRoutes } from "./routes/labels.ts";
import { mediaRoutes } from "./routes/media.ts";
import { montageRoutes } from "./routes/montages.ts";
import { movieRoutes } from "./routes/movies.ts";
import { privacyRoutes } from "./routes/privacy.ts";
import { projectRoutes } from "./routes/projects.ts";
import { pushRoutes } from "./routes/push.ts";
import { songRoutes } from "./routes/songs.ts";
import { uploadRoutes } from "./routes/uploads.ts";
import { userRoutes } from "./routes/users.ts";

export function registerRoutes(app: FastifyInstance): void {
  authPlugin(app);
  privacyRoutes(app);
  app.register(
    async (v1) => {
      authRoutes(v1);
      userRoutes(v1);
      projectRoutes(v1);
      mediaRoutes(v1);
      uploadRoutes(v1);
      labelRoutes(v1);
      songRoutes(v1);
      montageRoutes(v1);
      movieRoutes(v1);
      pushRoutes(v1);
      contactRoutes(v1);
    },
    { prefix: "/v1" },
  );
}
