CREATE TABLE IF NOT EXISTS hosts (
    id TEXT PRIMARY KEY,
    machineId TEXT NOT NULL,
    platform TEXT NOT NULL,
    createdAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hosts_machineId ON hosts (machineId);

DROP TABLE IF EXISTS waitlist;

CREATE TABLE IF NOT EXISTS clients (
    -- static
    id TEXT PRIMARY KEY,
    -- static
    platform TEXT NOT NULL,
    -- static
    deviceModel TEXT NOT NULL,
    -- static
    deviceIsEmulator INTEGER NOT NULL,
    -- static
    deviceManufacturer TEXT NOT NULL,
    -- might change if the user updates the app
    appVersion TEXT NOT NULL,
    -- static
    createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    avatarUrl TEXT,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_accounts (
    provider TEXT NOT NULL,
    providerAccountId TEXT NOT NULL,
    userId TEXT NOT NULL,
    email TEXT NOT NULL,
    isPrimary INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    PRIMARY KEY (provider, providerAccountId),
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_oauth_accounts_userId ON oauth_accounts (userId);
CREATE INDEX IF NOT EXISTS idx_oauth_accounts_email ON oauth_accounts (email);

CREATE TABLE IF NOT EXISTS oauth_login_states (
    stateHash TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'signin',
    userId TEXT,
    codeVerifier TEXT,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_exchange_codes (
    codeHash TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL,
    usedAt INTEGER,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auth_link_codes (
    codeHash TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    provider TEXT NOT NULL,
    providerAccountId TEXT NOT NULL,
    email TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL,
    usedAt INTEGER,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    lastSeenAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL,
    revokedAt INTEGER,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_userId ON auth_sessions (userId);

CREATE TABLE IF NOT EXISTS auth_access_tokens (
    tokenHash TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL,
    userId TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL,
    revokedAt INTEGER,
    FOREIGN KEY (sessionId) REFERENCES auth_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_auth_access_tokens_sessionId ON auth_access_tokens (sessionId);

CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
    tokenHash TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL,
    userId TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    lastUsedAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL,
    revokedAt INTEGER,
    replacedByHash TEXT,
    FOREIGN KEY (sessionId) REFERENCES auth_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_auth_refresh_tokens_sessionId ON auth_refresh_tokens (sessionId);
