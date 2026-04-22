CREATE TABLE IF NOT EXISTS hosts (
    id TEXT PRIMARY KEY,
    machineId TEXT NOT NULL,
    platform TEXT NOT NULL,
    createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS waitlist (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    social TEXT,
    platforms TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    sheetsFailed INTEGER NOT NULL DEFAULT 0
)