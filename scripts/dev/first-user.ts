import { sql } from "../../src/integrations/db/index.ts";
import { findOrCreateUser } from "../../src/services/auth/commands.ts";
import { createAppInvite } from "../../src/services/invite/commands.ts";
import { liveAppInvite } from "../../src/services/invite/queries.ts";
import { setName, setUsername } from "../../src/services/user/commands.ts";

async function main(): Promise<void> {
  const email = process.env.EMAIL?.trim();
  const username = process.env.USERNAME?.trim();
  if (!email || !username) throw new Error("EMAIL and USERNAME are required");
  const name = process.env.NAME?.trim() || username;

  const { userId } = await findOrCreateUser(email);
  const renamed = await setUsername(userId, username);
  if ("denial" in renamed) throw new Error(`username "${username}" is ${renamed.denial}`);
  await setName(userId, name);

  const now = new Date();
  let invite = await liveAppInvite(userId);
  const usable =
    invite !== undefined &&
    (invite.expiresAt === null || invite.expiresAt > now) &&
    (invite.maxUses === null || invite.usedCount < invite.maxUses);

  if (!usable) {
    await sql`
      update invites
      set revoked_at = now()
      where created_by = ${userId} and kind = 'app' and revoked_at is null
    `;
    invite = await createAppInvite({ createdBy: userId, maxUses: 1, expiresAt: null });
  }
  if (!invite) throw new Error("could not create an app invite");

  console.log(`first user: ${email} (@${username})`);
  console.log(`invite: ${invite.token}`);
  console.log("Enter this invite in the app before signing in as the invited person.");
}

main()
  .catch((error) => {
    console.error("first-user failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
