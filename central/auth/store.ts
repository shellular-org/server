import { db } from "@central/db";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
} from "@shared/http-error";
import { nanoid } from "nanoid";
import { createToken, hashToken } from "./crypto";

export type AuthProvider = "google" | "github" | "apple";

export type AuthLinkedAccount = {
  provider: AuthProvider;
  email: string;
  isPrimary: boolean;
  linkedAt: number;
};

export type AuthUser = {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  linkedAccounts: AuthLinkedAccount[];
};

export type LoginState = {
  provider: AuthProvider;
  purpose: "signin" | "link";
  userId: string | null;
  codeVerifier: string | null;
  callbackUrl: string | null;
  expiresAt: number;
};

export type TokenPair = {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  user: AuthUser;
};

export type ProviderProfile = {
  provider: AuthProvider;
  providerAccountId: string;
  email: string;
  emailVerified: boolean;
  name?: string | null;
  avatarUrl?: string | null;
};

const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const REFRESH_TOKEN_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_STATE_TTL_MS = 10 * 60 * 1000;
const EXCHANGE_CODE_TTL_MS = 5 * 60 * 1000;
const LINK_CODE_TTL_MS = 5 * 60 * 1000;

export function saveLoginState(
  state: string,
  provider: AuthProvider,
  options: {
    codeVerifier?: string;
    callbackUrl?: string;
    purpose?: LoginState["purpose"];
    userId?: string;
  } = {},
) {
  const now = Date.now();
  db.prepare(
    "INSERT INTO oauth_login_states (stateHash, provider, purpose, userId, codeVerifier, callbackUrl, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    hashToken(state),
    provider,
    options.purpose ?? "signin",
    options.userId ?? null,
    options.codeVerifier ?? null,
    options.callbackUrl ?? null,
    now,
    now + LOGIN_STATE_TTL_MS,
  );
}

export function consumeLoginState(
  state: string,
  provider: AuthProvider,
): LoginState {
  const stateHash = hashToken(state);
  const row = db
    .prepare(
      "SELECT provider, purpose, userId, codeVerifier, callbackUrl, expiresAt FROM oauth_login_states WHERE stateHash = ?",
    )
    .get(stateHash) as LoginState | undefined;

  db.prepare("DELETE FROM oauth_login_states WHERE stateHash = ?").run(
    stateHash,
  );

  if (!row || row.provider !== provider || row.expiresAt < Date.now()) {
    throw new BadRequestError(
      "This sign-in request expired. Please try again.",
    );
  }

  return row;
}

export function getLoginStateCallbackUrl(
  state: string,
  provider: AuthProvider,
): string | null {
  const row = db
    .prepare(
      "SELECT provider, callbackUrl, expiresAt FROM oauth_login_states WHERE stateHash = ?",
    )
    .get(hashToken(state)) as
    | Pick<LoginState, "provider" | "callbackUrl" | "expiresAt">
    | undefined;

  if (!row || row.provider !== provider || row.expiresAt < Date.now()) {
    return null;
  }

  return row.callbackUrl;
}

export function assertProviderCanBeLinked(
  userId: string,
  provider: AuthProvider,
): void {
  const existing = db
    .prepare(
      "SELECT provider FROM oauth_accounts WHERE userId = ? AND provider = ?",
    )
    .get(userId, provider) as { provider: AuthProvider } | undefined;
  if (existing) {
    throw new ConflictError("This provider is already linked.");
  }
}

export function upsertUserFromProvider(profile: ProviderProfile): AuthUser {
  const email = verifiedProfileEmail(profile);

  const now = Date.now();
  const account = db
    .prepare(
      "SELECT userId, isPrimary FROM oauth_accounts WHERE provider = ? AND providerAccountId = ?",
    )
    .get(profile.provider, profile.providerAccountId) as
    | { userId: string; isPrimary: number }
    | undefined;

  let user = account ? getUserById(account.userId) : getUserByEmail(email);
  if (!user) {
    const id = `u_${nanoid(18)}`;
    db.prepare(
      "INSERT INTO users (id, email, name, avatarUrl, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, email, profile.name ?? null, profile.avatarUrl ?? null, now, now);
    user = getUserById(id);
  } else if (!account || account.isPrimary) {
    db.prepare(
      "UPDATE users SET name = COALESCE(?, name), avatarUrl = COALESCE(?, avatarUrl), updatedAt = ? WHERE id = ?",
    ).run(profile.name ?? null, profile.avatarUrl ?? null, now, user.id);
    user = getUserById(user.id);
  }

  if (!user) {
    throw new Error("Failed to create authenticated user");
  }

  if (!account) {
    const existingProviderForUser = db
      .prepare(
        "SELECT providerAccountId FROM oauth_accounts WHERE userId = ? AND provider = ?",
      )
      .get(user.id, profile.provider) as
      | { providerAccountId: string }
      | undefined;
    if (existingProviderForUser) {
      throw new ConflictError("This provider is already linked.");
    }
  }

  const isPrimary = account?.isPrimary ?? (hasPrimaryAccount(user.id) ? 0 : 1);
  db.prepare(
    `INSERT INTO oauth_accounts (provider, providerAccountId, userId, email, isPrimary, createdAt, updatedAt)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(provider, providerAccountId)
		 DO UPDATE SET userId = excluded.userId, email = excluded.email, updatedAt = excluded.updatedAt`,
  ).run(
    profile.provider,
    profile.providerAccountId,
    user.id,
    email,
    isPrimary,
    now,
    now,
  );

  return getUserById(user.id) ?? user;
}

export function createLinkCode(
  userId: string,
  profile: ProviderProfile,
): string {
  const email = verifiedProfileEmail(profile);
  const code = createToken("lnk");
  const now = Date.now();
  db.prepare(
    `INSERT INTO auth_link_codes
		 (codeHash, userId, provider, providerAccountId, email, createdAt, expiresAt)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    hashToken(code),
    userId,
    profile.provider,
    profile.providerAccountId,
    email,
    now,
    now + LINK_CODE_TTL_MS,
  );
  return code;
}

export function exchangeLinkCodeForAccount(
  code: string,
  userId: string,
): AuthUser {
  const codeHash = hashToken(code);
  const row = db
    .prepare(
      `SELECT userId, provider, providerAccountId, email, expiresAt, usedAt
			 FROM auth_link_codes
			 WHERE codeHash = ?`,
    )
    .get(codeHash) as
    | {
        userId: string;
        provider: AuthProvider;
        providerAccountId: string;
        email: string;
        expiresAt: number;
        usedAt: number | null;
      }
    | undefined;

  if (!row || row.usedAt || row.expiresAt < Date.now()) {
    throw new BadRequestError(
      "This account-linking request expired. Please try again.",
    );
  }

  if (row.userId !== userId) {
    throw new ForbiddenError("This account-linking request is not yours.");
  }

  db.prepare("UPDATE auth_link_codes SET usedAt = ? WHERE codeHash = ?").run(
    Date.now(),
    codeHash,
  );

  return linkProviderAccount(userId, {
    provider: row.provider,
    providerAccountId: row.providerAccountId,
    email: row.email,
    emailVerified: true,
  });
}

export function unlinkProviderAccount(
  userId: string,
  provider: AuthProvider,
): AuthUser {
  const row = db
    .prepare(
      "SELECT isPrimary FROM oauth_accounts WHERE userId = ? AND provider = ?",
    )
    .get(userId, provider) as { isPrimary: number } | undefined;
  if (!row) {
    throw new BadRequestError("This provider is not linked.");
  }
  if (row.isPrimary) {
    throw new ForbiddenError("Your primary account cannot be unlinked.");
  }

  db.prepare(
    "DELETE FROM oauth_accounts WHERE userId = ? AND provider = ?",
  ).run(userId, provider);
  const user = getUserById(userId);
  if (!user) throw new ForbiddenError("Your account is no longer available.");
  return user;
}

export function linkProviderAccount(
  userId: string,
  profile: ProviderProfile,
): AuthUser {
  const email = verifiedProfileEmail(profile);
  const user = getUserById(userId);
  if (!user) throw new ForbiddenError("Your account is no longer available.");

  const linkedIdentity = db
    .prepare(
      "SELECT userId FROM oauth_accounts WHERE provider = ? AND providerAccountId = ?",
    )
    .get(profile.provider, profile.providerAccountId) as
    | { userId: string }
    | undefined;
  if (linkedIdentity?.userId === userId) {
    throw new ConflictError("This provider is already linked.");
  }
  if (linkedIdentity) {
    throw new ConflictError(
      "This OAuth account is already linked to another Shellular user.",
    );
  }

  assertProviderCanBeLinked(userId, profile.provider);
  const now = Date.now();
  db.prepare(
    `INSERT INTO oauth_accounts
		 (provider, providerAccountId, userId, email, isPrimary, createdAt, updatedAt)
		 VALUES (?, ?, ?, ?, 0, ?, ?)`,
  ).run(profile.provider, profile.providerAccountId, userId, email, now, now);

  const nextUser = getUserById(userId);
  if (!nextUser)
    throw new ForbiddenError("Your account is no longer available.");
  return nextUser;
}

export function createExchangeCode(userId: string): string {
  const code = createToken("exc");
  const now = Date.now();
  db.prepare(
    "INSERT INTO auth_exchange_codes (codeHash, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)",
  ).run(hashToken(code), userId, now, now + EXCHANGE_CODE_TTL_MS);
  return code;
}

export function exchangeCodeForTokens(code: string): TokenPair {
  const codeHash = hashToken(code);
  const row = db
    .prepare(
      "SELECT userId, expiresAt, usedAt FROM auth_exchange_codes WHERE codeHash = ?",
    )
    .get(codeHash) as
    | { userId: string; expiresAt: number; usedAt: number | null }
    | undefined;

  if (!row || row.usedAt || row.expiresAt < Date.now()) {
    throw new BadRequestError(
      "This sign-in link expired. Please sign in again.",
    );
  }

  db.prepare(
    "UPDATE auth_exchange_codes SET usedAt = ? WHERE codeHash = ?",
  ).run(Date.now(), codeHash);

  return createSession(row.userId);
}

export function refreshToken(refreshToken: string): TokenPair {
  const now = Date.now();
  const tokenHash = hashToken(refreshToken);
  const token = db
    .prepare(
      `SELECT tokenHash, sessionId, userId, expiresAt, revokedAt
			 FROM auth_refresh_tokens WHERE tokenHash = ?`,
    )
    .get(tokenHash) as
    | {
        tokenHash: string;
        sessionId: string;
        userId: string;
        expiresAt: number;
        revokedAt: number | null;
      }
    | undefined;

  if (!token || token.revokedAt || token.expiresAt < now) {
    throw new ForbiddenError("Your session expired. Please sign in again.");
  }

  const session = getLiveSession(token.sessionId);
  if (!session) {
    throw new ForbiddenError("Your session expired. Please sign in again.");
  }

  const user = getUserById(token.userId);
  if (!user) {
    throw new ForbiddenError("Your account is no longer available.");
  }

  const nextRefreshToken = createToken("rfr");
  const nextRefreshHash = hashToken(nextRefreshToken);
  db.prepare(
    "UPDATE auth_refresh_tokens SET revokedAt = ?, replacedByHash = ? WHERE tokenHash = ?",
  ).run(now, nextRefreshHash, tokenHash);
  db.prepare(
    "INSERT INTO auth_refresh_tokens (tokenHash, sessionId, userId, createdAt, lastUsedAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    nextRefreshHash,
    session.id,
    user.id,
    now,
    now,
    now + REFRESH_TOKEN_IDLE_TTL_MS,
  );
  touchSession(session.id, now + REFRESH_TOKEN_IDLE_TTL_MS);

  const access = createAccessToken(session.id, user.id);
  return {
    ...access,
    refreshToken: nextRefreshToken,
    refreshTokenExpiresAt: now + REFRESH_TOKEN_IDLE_TTL_MS,
    user,
  };
}

export function validateAccessToken(accessToken: string): AuthUser | null {
  const now = Date.now();
  const row = db
    .prepare(
      `SELECT sessionId, userId, expiresAt, revokedAt
			 FROM auth_access_tokens WHERE tokenHash = ?`,
    )
    .get(hashToken(accessToken)) as
    | {
        sessionId: string;
        userId: string;
        expiresAt: number;
        revokedAt: number | null;
      }
    | undefined;

  if (
    !row ||
    row.revokedAt ||
    row.expiresAt < now ||
    !getLiveSession(row.sessionId)
  ) {
    return null;
  }

  touchSession(row.sessionId);
  return getUserById(row.userId) ?? null;
}

export function revokeSessionByRefreshToken(refreshToken: string): void {
  const row = db
    .prepare("SELECT sessionId FROM auth_refresh_tokens WHERE tokenHash = ?")
    .get(hashToken(refreshToken)) as { sessionId: string } | undefined;
  if (row) revokeSession(row.sessionId);
}

export function revokeSessionByAccessToken(accessToken: string): void {
  const row = db
    .prepare("SELECT sessionId FROM auth_access_tokens WHERE tokenHash = ?")
    .get(hashToken(accessToken)) as { sessionId: string } | undefined;
  if (row) revokeSession(row.sessionId);
}

export function createSession(userId: string): TokenPair {
  const user = getUserById(userId);
  if (!user) {
    throw new ForbiddenError("Your account is no longer available.");
  }

  const now = Date.now();
  const sessionId = `ses_${nanoid(24)}`;
  const refreshTokenValue = createToken("rfr");
  const refreshTokenHash = hashToken(refreshTokenValue);
  const refreshExpiresAt = now + REFRESH_TOKEN_IDLE_TTL_MS;

  db.prepare(
    "INSERT INTO auth_sessions (id, userId, createdAt, lastSeenAt, expiresAt) VALUES (?, ?, ?, ?, ?)",
  ).run(sessionId, userId, now, now, refreshExpiresAt);
  db.prepare(
    "INSERT INTO auth_refresh_tokens (tokenHash, sessionId, userId, createdAt, lastUsedAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(refreshTokenHash, sessionId, userId, now, now, refreshExpiresAt);

  const access = createAccessToken(sessionId, userId);
  return {
    ...access,
    refreshToken: refreshTokenValue,
    refreshTokenExpiresAt: refreshExpiresAt,
    user,
  };
}

function createAccessToken(sessionId: string, userId: string) {
  const accessToken = createToken("acc");
  const now = Date.now();
  const accessTokenExpiresAt = now + ACCESS_TOKEN_TTL_MS;
  db.prepare(
    "INSERT INTO auth_access_tokens (tokenHash, sessionId, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?)",
  ).run(hashToken(accessToken), sessionId, userId, now, accessTokenExpiresAt);
  return { accessToken, accessTokenExpiresAt };
}

function getLiveSession(sessionId: string) {
  const now = Date.now();
  return db
    .prepare(
      "SELECT id FROM auth_sessions WHERE id = ? AND revokedAt IS NULL AND expiresAt > ?",
    )
    .get(sessionId, now) as { id: string } | undefined;
}

function touchSession(sessionId: string, expiresAt?: number): void {
  const now = Date.now();
  db.prepare(
    "UPDATE auth_sessions SET lastSeenAt = ?, expiresAt = COALESCE(?, expiresAt) WHERE id = ?",
  ).run(now, expiresAt ?? null, sessionId);
}

function revokeSession(sessionId: string): void {
  const now = Date.now();
  db.prepare("UPDATE auth_sessions SET revokedAt = ? WHERE id = ?").run(
    now,
    sessionId,
  );
  db.prepare(
    "UPDATE auth_access_tokens SET revokedAt = ? WHERE sessionId = ? AND revokedAt IS NULL",
  ).run(now, sessionId);
  db.prepare(
    "UPDATE auth_refresh_tokens SET revokedAt = ? WHERE sessionId = ? AND revokedAt IS NULL",
  ).run(now, sessionId);
}

function getUserById(id: string): AuthUser | undefined {
  const user = db
    .prepare("SELECT id, email, name, avatarUrl FROM users WHERE id = ?")
    .get(id) as Omit<AuthUser, "linkedAccounts"> | undefined;
  return user ? { ...user, linkedAccounts: getLinkedAccounts(id) } : undefined;
}

function getUserByEmail(email: string): AuthUser | undefined {
  const user = db
    .prepare("SELECT id, email, name, avatarUrl FROM users WHERE email = ?")
    .get(email) as Omit<AuthUser, "linkedAccounts"> | undefined;
  return user
    ? { ...user, linkedAccounts: getLinkedAccounts(user.id) }
    : undefined;
}

function getLinkedAccounts(userId: string): AuthLinkedAccount[] {
  const rows = db
    .prepare(
      `SELECT provider, email, isPrimary, createdAt
			 FROM oauth_accounts
			 WHERE userId = ?
			 ORDER BY isPrimary DESC, createdAt ASC, provider ASC`,
    )
    .all(userId) as Array<{
    provider: AuthProvider;
    email: string;
    isPrimary: number;
    createdAt: number;
  }>;
  return rows.map((row) => ({
    provider: row.provider,
    email: row.email,
    isPrimary: Boolean(row.isPrimary),
    linkedAt: row.createdAt,
  }));
}

function hasPrimaryAccount(userId: string): boolean {
  const row = db
    .prepare(
      "SELECT provider FROM oauth_accounts WHERE userId = ? AND isPrimary = 1 LIMIT 1",
    )
    .get(userId) as { provider: AuthProvider } | undefined;
  return Boolean(row);
}

function verifiedProfileEmail(profile: ProviderProfile): string {
  if (!profile.emailVerified) {
    throw new ForbiddenError(
      "Your OAuth provider did not return a verified email address.",
    );
  }

  const email = profile.email.trim().toLowerCase();
  if (!email) {
    throw new ForbiddenError(
      "Your OAuth provider did not return an email address.",
    );
  }
  return email;
}
