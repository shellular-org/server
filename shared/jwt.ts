import { jwtVerify, SignJWT } from "jose";
import type { z } from "zod";

import { sharedEnv } from "./env";

const ALG = "HS256";
// jose signs/verifies HS* with the raw secret bytes.
const SECRET = new TextEncoder().encode(sharedEnv.WS_TOKEN_SECRET);

/**
 * Creates a JWT with the given claims and TTL.
 *
 * https://github.com/panva/jose/blob/HEAD/docs/jwt/sign/classes/SignJWT.md
 *
 * @param claims
 * @param ttlSeconds
 * @returns A promise that resolves to the signed JWT string.
 */
export function createToken(
  claims: Record<string, unknown>,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(SECRET);
}

/**
 * Verifies a JWT and parses its payload with a Zod schema. Returns the parsed payload on success, or `null` on failure.
 *
 * https://github.com/panva/jose/blob/HEAD/docs/jwt/verify/functions/jwtVerify.md
 *
 * @param token
 * @param schema
 * @returns A promise that resolves to the parsed payload on success, or `null` on failure.
 */
export async function verifyToken<T>(
  token: string,
  schema: z.ZodSchema<T>,
): Promise<T | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET, { algorithms: [ALG] });
    const parsed = schema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
