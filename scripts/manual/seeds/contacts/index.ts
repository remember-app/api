import { get, post, type Token, tokenOf } from "../common.ts";

const CHAIN = [
  ["alice", "bob"],
  ["bob", "carol"],
  ["carol", "dave"],
  ["dave", "alice"],
] as const;

type ContactsPage = { items: { username: string | null }[] };

export async function seedContacts(tokens: Map<string, Token>): Promise<void> {
  const known = new Map<string, Set<string | null>>();
  for (const [sender, invitee] of CHAIN) {
    const token = tokenOf(tokens, sender);
    let contacts = known.get(sender);
    if (!contacts) {
      const page = await get<ContactsPage>("/v1/me/contacts?limit=200", token);
      contacts = new Set(page.items.map((contact) => contact.username));
      known.set(sender, contacts);
    }
    if (contacts.has(invitee)) continue;
    const invite = await post<{ token: string }>("/v1/invites/app", token, {});
    await post("/v1/invites/accept", tokenOf(tokens, invitee), { token: invite.token });
    contacts.add(invitee);
    console.log(`test seed: contact ${sender} → ${invitee}`);
  }
}
