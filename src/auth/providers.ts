import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import { appleClientId, googleClientId } from "./config.ts";
export type Provider = "apple" | "google";
export type ProviderClaims = {
  sub: string;
  name: string | null;
  email: string | null;
};
const providers = {
  apple: {
    issuer: "https://appleid.apple.com",
    audience: appleClientId,
    keys: createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys")),
  },
  google: {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: googleClientId,
    keys: createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs")),
  },
};
export const audienceOf = (provider: Provider) => providers[provider].audience();
export function claimsFrom(payload: JWTPayload): ProviderClaims {
  const { sub, name, email } = payload;
  if (typeof sub !== "string" || !sub) throw new Error("token carries no usable sub");
  return {
    sub,
    name: typeof name === "string" ? name : null,
    email: typeof email === "string" ? email : null,
  };
}
export const verifier = {
  async verify(provider: Provider, idToken: string): Promise<ProviderClaims> {
    const { issuer, audience, keys } = providers[provider];
    const aud = audience();
    if (!aud) throw new Error(`${provider} has no client id configured`);
    const { payload } = await jwtVerify(idToken, keys, { issuer, audience: aud });
    return claimsFrom(payload);
  },
};
