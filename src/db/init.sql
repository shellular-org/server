CREATE TABLE IF NOT EXISTS hosts (
    id TEXT PRIMARY KEY,
    machineId TEXT NOT NULL,
    platform TEXT NOT NULL,
    createdAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hosts_machineId ON hosts (machineId);

DROP TABLE IF EXISTS waitlist;