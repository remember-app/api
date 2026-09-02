import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import { appleClientId, googleClientId } from "./config.ts";

export type Provider = "apple" | "google";

/** All that is taken from an id token: a stable id, and whatever else it carries. */
export type ProviderClaims = { sub: string; name: string | null; email: string | null };

/**
 * What distinguishes the two providers, and all of it. `createRemoteJWKSet`
 * fetches nothing until the first verification and caches the keys afterwards
 * (with its own cooldown on rotation), so one instance per provider, made once
 * at import, is the whole key management there is.
 */
const providers = {
  apple: {
    issuer: "https://appleid.apple.com",
    audience: appleClientId,
    keys: createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys")),
  },
  google: {
    // Both forms, because Google documents both as its own and still mints the
    // bare one for some clients — a token refused over the missing scheme would
    // look exactly like a forgery in the log. This widens nothing: the gate is
    // the signature against Google's key set, which has one issuer behind it.
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: googleClientId,
    keys: createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs")),
  },
};

/** Undefined means the provider is switched off — nothing else configures it. */
export const audienceOf = (provider: Provider) => providers[provider].audience();

/**
 * The claims, taken from a payload jose has already vouched for.
 *
 * Every field is checked for its type rather than believed: a payload is parsed
 * JSON, so the types TypeScript states here are a promise nobody keeps at
 * runtime, and jose validates only the claims it is asked to (`iss`, `aud`,
 * `exp`). `sub` above all — it is the whole binding, and a `"sub": 123` would
 * otherwise travel as a number to a text column and come back a 500.
 */
export function claimsFrom(payload: JWTPayload): ProviderClaims {
  const { sub, name, email } = payload;
  if (typeof sub !== "string" || !sub) throw new Error("token carries no usable sub");
  return {
    sub,
    // Apple sends neither as a rule (the name comes back to the app once,
    // outside the token, and the address may be a private relay); Google sends
    // both. Absent — or not a string — is null, never a guess.
    name: typeof name === "string" ? name : null,
    email: typeof email === "string" ? email : null,
  };
}

/**
 * The verification of a provider id token, behind an object so a test can put
 * its own in place: there is no way to check a real Apple signature without
 * Apple's keys and a real token, and no way to make one.
 */
export const verifier = {
  /**
   * Signature against the provider's published keys, plus `iss`, `aud` and
   * `exp` (jose does the last three). Throws on anything that fails — the
   * caller owes the client one answer for all of them.
   */
  async verify(provider: Provider, idToken: string): Promise<ProviderClaims> {
    const { issuer, audience, keys } = providers[provider];
    const aud = audience();
    // The route refuses an unconfigured provider before reaching here. This is
    // the second lock on the same door, and the important one: jose skips the
    // audience check entirely when `audience` is undefined, so a missing client
    // id would not fail loudly — it would quietly accept tokens minted for any
    // other app at the same provider.
    if (!aud) throw new Error(`${provider} has no client id configured`);
    const { payload } = await jwtVerify(idToken, keys, { issuer, audience: aud });
    return claimsFrom(payload);
  },
};
