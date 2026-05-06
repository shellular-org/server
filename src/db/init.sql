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