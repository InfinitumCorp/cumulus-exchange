import { makeSignature } from "better-auth/crypto";

/**
 * Tests only: a signed session cookie for a person, without any sign-in UI.
 *
 * People sign in with Cumulus ID, so there is no email/password endpoint to
 * call. This creates the user and session the Cumulus ID callback would create
 * and signs the cookie the way Better Auth does.
 */
type AuthLike = { $context: Promise<unknown> };

export async function testSessionCookie(auth: AuthLike, email: string, name: string): Promise<string> {
  // The internal adapter is not part of the typed public surface.
  const ctx = (await auth.$context) as any;
  const found = await ctx.internalAdapter.findUserByEmail(email);
  const user = found?.user ?? (await ctx.internalAdapter.createUser({ email, name, emailVerified: true }));
  const session = await ctx.internalAdapter.createSession(user.id);
  const signature = await makeSignature(session.token, ctx.secret);
  return `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`;
}
