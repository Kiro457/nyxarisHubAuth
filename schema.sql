PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS admins (
	id        INTEGER PRIMARY KEY AUTOINCREMENT,
	username  TEXT NOT NULL UNIQUE,
	passHash  TEXT NOT NULL,
	createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
	tokenHash TEXT PRIMARY KEY,
	adminId   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
	csrf      TEXT NOT NULL,
	expiresAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scripts (
	id        TEXT PRIMARY KEY,
	name      TEXT NOT NULL,
	secret    TEXT NOT NULL,
	source    TEXT NOT NULL DEFAULT '',
	version   INTEGER NOT NULL DEFAULT 1,
	enabled   INTEGER NOT NULL DEFAULT 1,
	createdAt INTEGER NOT NULL,
	updatedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS keys (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	key         TEXT NOT NULL UNIQUE,
	scriptId    TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
	note        TEXT NOT NULL DEFAULT '',
	status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','banned')),
	maxHwids    INTEGER NOT NULL DEFAULT 1,
	expiresAt   INTEGER,
	uses        INTEGER NOT NULL DEFAULT 0,
	lastUsedAt  INTEGER,
	lastResetAt INTEGER,
	createdAt   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idxKeysScript ON keys(scriptId);

CREATE TABLE IF NOT EXISTS hwids (
	id        INTEGER PRIMARY KEY AUTOINCREMENT,
	keyId     INTEGER NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
	hwid      TEXT NOT NULL,
	firstSeen INTEGER NOT NULL,
	lastSeen  INTEGER NOT NULL,
	UNIQUE (keyId, hwid)
);

CREATE TABLE IF NOT EXISTS blacklist (
	id        INTEGER PRIMARY KEY AUTOINCREMENT,
	type      TEXT NOT NULL CHECK (type IN ('hwid','ip')),
	value     TEXT NOT NULL,
	reason    TEXT NOT NULL DEFAULT '',
	createdAt INTEGER NOT NULL,
	UNIQUE (type, value)
);

CREATE TABLE IF NOT EXISTS logs (
	id       INTEGER PRIMARY KEY AUTOINCREMENT,
	ts       INTEGER NOT NULL,
	keyId    INTEGER,
	scriptId TEXT,
	hwid     TEXT,
	ip       TEXT,
	userId   TEXT,
	placeId  TEXT,
	result   TEXT NOT NULL,
	detail   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idxLogsTs ON logs(ts DESC);
