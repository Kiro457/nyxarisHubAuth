"use strict";

// NYXARIS AUTH - self-hosted script licensing. Zero dependencies (Node >= 22.5).

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

// Config.
loadEnv(path.join(__dirname, ".env"));

const ON_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT;
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || (ON_RAILWAY ? "0.0.0.0" : "127.0.0.1");
const DB_PATH = path.resolve(__dirname, process.env.DB_PATH || (VOLUME ? path.join(VOLUME, "nyxaris.db") : "./data/nyxaris.db"));
const TRUST_PROXY = process.env.TRUST_PROXY ? process.env.TRUST_PROXY === "1" : ON_RAILWAY;
const COOKIE_SECURE = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "1" : ON_RAILWAY;
const SESSION_TTL = 12 * 60 * 60;
const MAX_BODY = 3 * 1024 * 1024;
const HWID_RESET_COOLDOWN = 24 * 60 * 60;
const PUBLIC_DIR = path.join(__dirname, "public");

// Database.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));

// Helpers.
function loadEnv(file) {
	if (!fs.existsSync(file)) return;
	for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
		if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
	}
}

const now = () => Math.floor(Date.now() / 1000);
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const hmac = (secret, data) => crypto.createHmac("sha256", secret).update(data).digest("hex");
const randHex = (n) => crypto.randomBytes(n).toString("hex");

function safeEqual(a, b) {
	const ba = Buffer.from(String(a));
	const bb = Buffer.from(String(b));
	return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

const B32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generateKey() {
	const bytes = crypto.randomBytes(20);
	let out = "";
	for (let i = 0; i < 20; i++) {
		if (i > 0 && i % 5 === 0) out += "-";
		out += B32[bytes[i] % 32];
	}
	return "NYX-" + out;
}

function hashPassword(password) {
	const salt = crypto.randomBytes(16);
	const hash = crypto.scryptSync(password, salt, 64);
	return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function verifyPassword(password, stored) {
	const [alg, saltHex, hashHex] = String(stored).split("$");
	if (alg !== "scrypt") return false;
	const hash = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), 64);
	return crypto.timingSafeEqual(hash, Buffer.from(hashHex, "hex"));
}

// Fixed-window in-memory rate limiter.
const buckets = new Map();
function rateLimit(name, id, limit, windowSec) {
	const k = name + ":" + id;
	const t = now();
	let b = buckets.get(k);
	if (!b || b.reset <= t) {
		b = { count: 0, reset: t + windowSec };
		buckets.set(k, b);
	}
	b.count++;
	return b.count <= limit;
}
setInterval(() => {
	const t = now();
	for (const [k, b] of buckets) if (b.reset <= t) buckets.delete(k);
	db.prepare("DELETE FROM sessions WHERE expiresAt <= ?").run(t);
}, 60_000).unref();

function clientIp(req) {
	if (TRUST_PROXY) {
		const xf = req.headers["x-forwarded-for"];
		if (xf) return String(xf).split(",")[0].trim();
	}
	return req.socket.remoteAddress || "unknown";
}

// First-run admin.
(function bootstrapAdmin() {
	const row = db.prepare("SELECT COUNT(*) AS c FROM admins").get();
	if (row.c > 0) return;
	const username = process.env.ADMIN_USER || "admin";
	const password = process.env.ADMIN_PASS || randHex(9);
	db.prepare("INSERT INTO admins (username, passHash, createdAt) VALUES (?,?,?)").run(username, hashPassword(password), now());
	console.log("==============================================");
	console.log(" NYXARIS AUTH first-run admin created");
	console.log(` username: ${username}`);
	console.log(` password: ${password}`);
	console.log(" Change it from the dashboard after login.");
	console.log("==============================================");
})();

// HTTP plumbing.
function send(res, status, body, headers = {}) {
	const isObj = typeof body === "object" && !Buffer.isBuffer(body);
	const data = isObj ? JSON.stringify(body) : body;
	res.writeHead(status, {
		"Content-Type": isObj ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		...headers,
	});
	res.end(data);
}

function readJson(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (c) => {
			size += c.length;
			if (size > MAX_BODY) {
				reject(Object.assign(new Error("Body too large"), { status: 413 }));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => {
			if (size === 0) return resolve({});
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				reject(Object.assign(new Error("Invalid JSON"), { status: 400 }));
			}
		});
		req.on("error", reject);
	});
}

function parseCookies(req) {
	const out = {};
	for (const part of String(req.headers.cookie || "").split(";")) {
		const i = part.indexOf("=");
		if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
	}
	return out;
}

function getSession(req) {
	const token = parseCookies(req).nyx_session;
	if (!token) return null;
	const row = db
		.prepare("SELECT s.tokenHash, s.csrf, s.expiresAt, a.id AS adminId, a.username FROM sessions s JOIN admins a ON a.id = s.adminId WHERE s.tokenHash = ?")
		.get(sha256(token));
	if (!row || row.expiresAt <= now()) return null;
	return row;
}

const str = (v, max) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
const intOr = (v, d, min, max) => {
	const n = Number.isFinite(v) ? Math.trunc(v) : d;
	return Math.min(max, Math.max(min, n));
};

function logEvent(e) {
	db.prepare("INSERT INTO logs (ts, keyId, scriptId, hwid, ip, userId, placeId, result, detail) VALUES (?,?,?,?,?,?,?,?,?)").run(
		now(), e.keyId ?? null, e.scriptId ?? null, e.hwid ?? null, e.ip ?? null,
		e.userId ?? null, e.placeId ?? null, e.result, e.detail ?? ""
	);
}


// Hosted loader: /files/v1/loaders/<40 hex>.lua serves loader.lua with this script's config baked in.
const loaderIdFor = (script) => sha256(script.secret + ":" + script.id).slice(0, 40);

function publicBase(req) {
	if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, "");
	const proto = TRUST_PROXY && req.headers["x-forwarded-proto"] ? String(req.headers["x-forwarded-proto"]).split(",")[0].trim() : "http";
	const host = (TRUST_PROXY && req.headers["x-forwarded-host"]) || req.headers.host || `${HOST}:${PORT}`;
	return `${proto}://${host}`;
}

function serveLoader(req, res, loaderId) {
	if (!rateLimit("loader", clientIp(req), 60, 60)) return send(res, 429, "Too many requests");
	const script = db.prepare("SELECT id, secret, enabled FROM scripts").all().find((x) => loaderIdFor(x) === loaderId);
	if (!script || !script.enabled) return send(res, 404, "Not found");
	let lua = fs.readFileSync(path.join(__dirname, "loader", "loader.lua"), "utf8");
	lua = lua
		.replace(/apiUrl = "[^"]*"/, () => `apiUrl = "${publicBase(req)}/api/v1/auth"`)
		.replace(/scriptId = "[^"]*"/, () => `scriptId = "${script.id}"`)
		.replace(/secret = "[^"]*"/, () => `secret = "${script.secret}"`);
	send(res, 200, lua);
}

// Public client API: POST /api/v1/auth
const MESSAGES = {
	OK: "Authenticated.",
	BAD_REQUEST: "Malformed request.",
	RATE_LIMITED: "Too many requests.",
	NO_SCRIPT: "Unknown script.",
	SCRIPT_DISABLED: "Script is disabled.",
	BLACKLISTED: "You are blacklisted.",
	INVALID_KEY: "Invalid key.",
	KEY_BANNED: "Key is banned.",
	KEY_EXPIRED: "Key has expired.",
	HWID_MISMATCH: "Key is bound to another device.",
};

function signedReply(res, script, nonce, code, payload, extra = {}) {
	const ok = code === "OK";
	const ts = now();
	const payloadHash = ok ? sha256(payload) : "";
	// Signature binds the response to this request's nonce so it can't be replayed.
	const sig = script ? hmac(script.secret, `${nonce}|${ok ? 1 : 0}|${code}|${ts}|${payloadHash}`) : "";
	send(res, ok ? 200 : 403, {
		ok, code, message: MESSAGES[code] || code, ts, nonce, sig,
		version: script ? script.version : 0,
		...(ok ? { payload } : {}),
		...extra,
	});
}

async function handleAuth(req, res) {
	const ip = clientIp(req);
	if (!rateLimit("auth", ip, 30, 60)) {
		logEvent({ ip, result: "RATE_LIMITED" });
		return send(res, 429, { ok: false, code: "RATE_LIMITED", message: MESSAGES.RATE_LIMITED });
	}

	let body;
	try {
		body = await readJson(req);
	} catch (e) {
		return send(res, e.status || 400, { ok: false, code: "BAD_REQUEST", message: e.message });
	}

	const key = str(body.key, 64);
	const hwid = str(body.hwid, 128);
	const scriptId = str(body.script, 64);
	const nonce = str(body.nonce, 64);
	if (!key || !hwid || !scriptId || !nonce || !/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) {
		return send(res, 400, { ok: false, code: "BAD_REQUEST", message: MESSAGES.BAD_REQUEST });
	}
	const userId = body.userId != null ? String(body.userId).slice(0, 20) : null;
	const placeId = body.placeId != null ? String(body.placeId).slice(0, 20) : null;
	const ctx = { ip, hwid, scriptId, userId, placeId };

	const script = db.prepare("SELECT * FROM scripts WHERE id = ?").get(scriptId);
	if (!script) {
		logEvent({ ...ctx, scriptId: null, result: "NO_SCRIPT", detail: scriptId });
		return signedReply(res, null, nonce, "NO_SCRIPT");
	}
	if (!script.enabled) {
		logEvent({ ...ctx, result: "SCRIPT_DISABLED" });
		return signedReply(res, script, nonce, "SCRIPT_DISABLED");
	}

	const banned = db.prepare("SELECT 1 FROM blacklist WHERE (type='hwid' AND value=?) OR (type='ip' AND value=?)").get(hwid, ip);
	if (banned) {
		logEvent({ ...ctx, result: "BLACKLISTED" });
		return signedReply(res, script, nonce, "BLACKLISTED");
	}

	const keyRow = db.prepare("SELECT * FROM keys WHERE key = ? AND scriptId = ?").get(key, scriptId);
	if (!keyRow) {
		logEvent({ ...ctx, result: "INVALID_KEY", detail: key.slice(0, 12) });
		return signedReply(res, script, nonce, "INVALID_KEY");
	}
	ctx.keyId = keyRow.id;

	if (keyRow.status === "banned") {
		logEvent({ ...ctx, result: "KEY_BANNED" });
		return signedReply(res, script, nonce, "KEY_BANNED");
	}
	if (keyRow.expiresAt && keyRow.expiresAt <= now()) {
		logEvent({ ...ctx, result: "KEY_EXPIRED" });
		return signedReply(res, script, nonce, "KEY_EXPIRED");
	}

	// HWID binding.
	const t = now();
	const bound = db.prepare("SELECT id FROM hwids WHERE keyId = ? AND hwid = ?").get(keyRow.id, hwid);
	if (bound) {
		db.prepare("UPDATE hwids SET lastSeen = ? WHERE id = ?").run(t, bound.id);
	} else {
		const count = db.prepare("SELECT COUNT(*) AS c FROM hwids WHERE keyId = ?").get(keyRow.id).c;
		if (count >= keyRow.maxHwids) {
			logEvent({ ...ctx, result: "HWID_MISMATCH" });
			return signedReply(res, script, nonce, "HWID_MISMATCH");
		}
		db.prepare("INSERT INTO hwids (keyId, hwid, firstSeen, lastSeen) VALUES (?,?,?,?)").run(keyRow.id, hwid, t, t);
	}

	db.prepare("UPDATE keys SET uses = uses + 1, lastUsedAt = ? WHERE id = ?").run(t, keyRow.id);
	logEvent({ ...ctx, result: "OK" });
	signedReply(res, script, nonce, "OK", script.source, { expiresAt: keyRow.expiresAt });
}

// Admin API.
const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp("^" + pattern + "$"), handler, ...opts });

route("POST", "/admin/login", async (req, res, { body, ip }) => {
	if (!rateLimit("login", ip, 8, 300)) return send(res, 429, { error: "Too many attempts" });
	const username = str(body.username, 64);
	const password = str(body.password, 256);
	const admin = username && db.prepare("SELECT * FROM admins WHERE username = ?").get(username);
	// Always run a hash so response time doesn't reveal whether the user exists.
	const okPass = admin ? verifyPassword(password || "", admin.passHash) : (verifyPassword("x", hashPassword("y")), false);
	if (!admin || !okPass) return send(res, 401, { error: "Invalid credentials" });

	const token = randHex(32);
	const csrf = randHex(16);
	db.prepare("INSERT INTO sessions (tokenHash, adminId, csrf, expiresAt) VALUES (?,?,?,?)").run(sha256(token), admin.id, csrf, now() + SESSION_TTL);
	const cookie = `nyx_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL}${COOKIE_SECURE ? "; Secure" : ""}`;
	send(res, 200, { ok: true, username: admin.username, csrf }, { "Set-Cookie": cookie });
}, { public: true });

route("POST", "/admin/logout", (req, res, { session }) => {
	db.prepare("DELETE FROM sessions WHERE tokenHash = ?").run(session.tokenHash);
	send(res, 200, { ok: true }, { "Set-Cookie": "nyx_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
});

route("GET", "/admin/me", (req, res, { session }) => send(res, 200, { username: session.username, csrf: session.csrf }));

route("POST", "/admin/password", (req, res, { session, body }) => {
	const cur = str(body.current, 256);
	const next = str(body.next, 256);
	if (!cur || !next || next.length < 10) return send(res, 400, { error: "New password must be 10+ chars" });
	const admin = db.prepare("SELECT * FROM admins WHERE id = ?").get(session.adminId);
	if (!verifyPassword(cur, admin.passHash)) return send(res, 401, { error: "Current password wrong" });
	db.prepare("UPDATE admins SET passHash = ? WHERE id = ?").run(hashPassword(next), admin.id);
	// Invalidate all other sessions.
	db.prepare("DELETE FROM sessions WHERE adminId = ? AND tokenHash != ?").run(admin.id, session.tokenHash);
	send(res, 200, { ok: true });
});

route("GET", "/admin/stats", (req, res, { query }) => {
	const t = now();
	const sc = query.get("script") || null;
	const kw = sc ? " AND scriptId = ?" : "";
	const one = (sql, ...a) => db.prepare(sql).get(...a).c;
	const sa = sc ? [sc] : [];
	send(res, 200, {
		scripts: one("SELECT COUNT(*) c FROM scripts"),
		keys: one(`SELECT COUNT(*) c FROM keys WHERE 1=1${kw}`, ...sa),
		activeKeys: one(`SELECT COUNT(*) c FROM keys WHERE status='active' AND (expiresAt IS NULL OR expiresAt > ?)${kw}`, t, ...sa),
		bannedKeys: one(`SELECT COUNT(*) c FROM keys WHERE status='banned'${kw}`, ...sa),
		auths24h: one(`SELECT COUNT(*) c FROM logs WHERE result='OK' AND ts > ?${kw}`, t - 86400, ...sa),
		fails24h: one(`SELECT COUNT(*) c FROM logs WHERE result!='OK' AND ts > ?${kw}`, t - 86400, ...sa),
		totalExecs: one(`SELECT COUNT(*) c FROM logs WHERE result='OK'${kw}`, ...sa),
		blacklist: one("SELECT COUNT(*) c FROM blacklist"),
	});
});

route("GET", "/admin/chart", (req, res, { query }) => {
	const days = intOr(parseInt(query.get("days")), 14, 1, 90);
	const args = [now() - days * 86400];
	let where = "ts > ?";
	if (query.get("script")) { where += " AND scriptId = ?"; args.push(query.get("script")); }
	const rows = db.prepare(
		`SELECT strftime('%Y-%m-%d', ts, 'unixepoch') AS day, SUM(result='OK') AS ok, SUM(result!='OK') AS fail FROM logs WHERE ${where} GROUP BY day`
	).all(...args);
	const map = new Map(rows.map((r) => [r.day, r]));
	const out = [];
	for (let i = days - 1; i >= 0; i--) {
		const day = new Date((now() - i * 86400) * 1000).toISOString().slice(0, 10);
		const r = map.get(day);
		out.push({ day, ok: r ? Number(r.ok) : 0, fail: r ? Number(r.fail) : 0 });
	}
	send(res, 200, out);
});

// Scripts.
route("GET", "/admin/scripts", (req, res) => {
	send(res, 200, db.prepare(
		"SELECT s.id, s.name, s.version, s.enabled, s.createdAt, s.updatedAt, length(s.source) AS size, (SELECT COUNT(*) FROM keys k WHERE k.scriptId = s.id) AS keyCount FROM scripts s ORDER BY s.createdAt DESC"
	).all());
});

route("POST", "/admin/scripts", (req, res, { body }) => {
	const name = str(body.name, 80);
	if (!name) return send(res, 400, { error: "Name required" });
	const id = randHex(8);
	const secret = randHex(32);
	const t = now();
	db.prepare("INSERT INTO scripts (id, name, secret, source, createdAt, updatedAt) VALUES (?,?,?,?,?,?)").run(id, name, secret, typeof body.source === "string" ? body.source : "", t, t);
	send(res, 201, { id, secret });
});

route("GET", "/admin/scripts/([a-f0-9]+)", (req, res, { params }) => {
	const s = db.prepare("SELECT id, name, secret, source, version, enabled FROM scripts WHERE id = ?").get(params[0]);
	s ? send(res, 200, { ...s, loaderId: loaderIdFor(s) }) : send(res, 404, { error: "Not found" });
});

route("PATCH", "/admin/scripts/([a-f0-9]+)", (req, res, { params, body }) => {
	const s = db.prepare("SELECT * FROM scripts WHERE id = ?").get(params[0]);
	if (!s) return send(res, 404, { error: "Not found" });
	const name = body.name !== undefined ? str(body.name, 80) || s.name : s.name;
	const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : s.enabled;
	let source = s.source;
	let version = s.version;
	if (typeof body.source === "string" && body.source !== s.source) {
		source = body.source;
		version++;
	}
	let secret = s.secret;
	if (body.rotateSecret) secret = randHex(32);
	db.prepare("UPDATE scripts SET name=?, enabled=?, source=?, version=?, secret=?, updatedAt=? WHERE id=?").run(name, enabled, source, version, secret, now(), s.id);
	send(res, 200, { ok: true, version, ...(body.rotateSecret ? { secret } : {}) });
});

route("DELETE", "/admin/scripts/([a-f0-9]+)", (req, res, { params }) => {
	db.prepare("DELETE FROM scripts WHERE id = ?").run(params[0]);
	send(res, 200, { ok: true });
});

// Keys.
route("GET", "/admin/keys", (req, res, { query }) => {
	const where = [];
	const args = [];
	const t = now();
	if (query.get("script")) { where.push("k.scriptId = ?"); args.push(query.get("script")); }
	if (query.get("q")) { where.push("(k.key LIKE ? OR k.note LIKE ?)"); const q = `%${query.get("q")}%`; args.push(q, q); }
	const st = query.get("status");
	if (st === "active") { where.push("k.status='active' AND (k.expiresAt IS NULL OR k.expiresAt > ?)"); args.push(t); }
	else if (st === "banned") where.push("k.status='banned'");
	else if (st === "expired") { where.push("k.expiresAt IS NOT NULL AND k.expiresAt <= ?"); args.push(t); }
	const w = where.length ? "WHERE " + where.join(" AND ") : "";
	const limit = intOr(parseInt(query.get("limit")), 20, 1, 200);
	const offset = intOr(parseInt(query.get("offset")), 0, 0, 1e9);
	const total = db.prepare(`SELECT COUNT(*) AS c FROM keys k ${w}`).get(...args).c;
	const rows = db.prepare(
		`SELECT k.*, s.name AS scriptName, (SELECT COUNT(*) FROM hwids h WHERE h.keyId = k.id) AS hwidCount
		 FROM keys k JOIN scripts s ON s.id = k.scriptId ${w} ORDER BY k.id DESC LIMIT ? OFFSET ?`
	).all(...args, limit, offset);
	send(res, 200, { rows, total });
});

route("POST", "/admin/keys", (req, res, { body }) => {
	const scriptId = str(body.scriptId, 64);
	if (!scriptId || !db.prepare("SELECT 1 FROM scripts WHERE id = ?").get(scriptId)) return send(res, 400, { error: "Valid scriptId required" });
	const count = intOr(body.count, 1, 1, 500);
	const maxHwids = intOr(body.maxHwids, 1, 1, 20);
	const note = typeof body.note === "string" ? body.note.slice(0, 200) : "";
	// durationDays = 0 or missing means lifetime.
	const days = intOr(body.durationDays, 0, 0, 36500);
	const expiresAt = days > 0 ? now() + days * 86400 : null;
	const ins = db.prepare("INSERT INTO keys (key, scriptId, note, maxHwids, expiresAt, createdAt) VALUES (?,?,?,?,?,?)");
	const created = [];
	db.exec("BEGIN");
	try {
		for (let i = 0; i < count; i++) {
			const key = generateKey();
			ins.run(key, scriptId, note, maxHwids, expiresAt, now());
			created.push(key);
		}
		db.exec("COMMIT");
	} catch (e) {
		db.exec("ROLLBACK");
		throw e;
	}
	send(res, 201, { keys: created });
});

route("PATCH", "/admin/keys/(\\d+)", (req, res, { params, body }) => {
	const k = db.prepare("SELECT * FROM keys WHERE id = ?").get(params[0]);
	if (!k) return send(res, 404, { error: "Not found" });
	if (body.status === "active" || body.status === "banned") db.prepare("UPDATE keys SET status = ? WHERE id = ?").run(body.status, k.id);
	if (typeof body.note === "string") db.prepare("UPDATE keys SET note = ? WHERE id = ?").run(body.note.slice(0, 200), k.id);
	if (body.maxHwids !== undefined) db.prepare("UPDATE keys SET maxHwids = ? WHERE id = ?").run(intOr(body.maxHwids, 1, 1, 20), k.id);
	if (body.extendDays !== undefined) {
		const add = intOr(body.extendDays, 0, -3650, 36500) * 86400;
		const base = k.expiresAt && k.expiresAt > now() ? k.expiresAt : now();
		db.prepare("UPDATE keys SET expiresAt = ? WHERE id = ?").run(base + add, k.id);
	}
	if (body.lifetime) db.prepare("UPDATE keys SET expiresAt = NULL WHERE id = ?").run(k.id);
	if (body.resetHwid) {
		// Admin reset ignores the cooldown; the cooldown is for any future self-service flow.
		db.prepare("DELETE FROM hwids WHERE keyId = ?").run(k.id);
		db.prepare("UPDATE keys SET lastResetAt = ? WHERE id = ?").run(now(), k.id);
	}
	send(res, 200, { ok: true });
});

route("DELETE", "/admin/keys/(\\d+)", (req, res, { params }) => {
	db.prepare("DELETE FROM keys WHERE id = ?").run(params[0]);
	send(res, 200, { ok: true });
});

route("GET", "/admin/keys/(\\d+)/hwids", (req, res, { params }) => {
	send(res, 200, db.prepare("SELECT hwid, firstSeen, lastSeen FROM hwids WHERE keyId = ? ORDER BY firstSeen").all(params[0]));
});

// Blacklist.
route("GET", "/admin/blacklist", (req, res) => send(res, 200, db.prepare("SELECT * FROM blacklist ORDER BY id DESC").all()));

route("POST", "/admin/blacklist", (req, res, { body }) => {
	const type = body.type === "ip" ? "ip" : body.type === "hwid" ? "hwid" : null;
	const value = str(body.value, 128);
	if (!type || !value) return send(res, 400, { error: "type (hwid|ip) and value required" });
	db.prepare("INSERT OR IGNORE INTO blacklist (type, value, reason, createdAt) VALUES (?,?,?,?)").run(type, value, typeof body.reason === "string" ? body.reason.slice(0, 200) : "", now());
	send(res, 201, { ok: true });
});

route("DELETE", "/admin/blacklist/(\\d+)", (req, res, { params }) => {
	db.prepare("DELETE FROM blacklist WHERE id = ?").run(params[0]);
	send(res, 200, { ok: true });
});

// Logs.
route("GET", "/admin/logs", (req, res, { query }) => {
	const where = [];
	const args = [];
	if (query.get("result")) { where.push("l.result = ?"); args.push(query.get("result")); }
	if (query.get("script")) { where.push("l.scriptId = ?"); args.push(query.get("script")); }
	const limit = intOr(parseInt(query.get("limit")), 200, 1, 1000);
	send(res, 200, db.prepare(
		`SELECT l.*, k.key AS keyValue FROM logs l LEFT JOIN keys k ON k.id = l.keyId ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY l.id DESC LIMIT ?`
	).all(...args, limit));
});

route("DELETE", "/admin/logs", (req, res) => {
	db.prepare("DELETE FROM logs").run();
	send(res, 200, { ok: true });
});

// Static dashboard.
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function serveStatic(req, res, pathname) {
	const rel = pathname === "/" ? "index.html" : pathname.slice(1);
	const file = path.resolve(PUBLIC_DIR, rel);
	if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
		return send(res, 404, "Not found");
	}
	res.writeHead(200, {
		"Content-Type": MIME[path.extname(file)] || "application/octet-stream",
		"Content-Security-Policy": CSP,
		"X-Frame-Options": "DENY",
		"Referrer-Policy": "no-referrer",
		"X-Content-Type-Options": "nosniff",
		"Cache-Control": "no-cache",
	});
	fs.createReadStream(file).pipe(res);
}

// Router.
const server = http.createServer(async (req, res) => {
	try {
		const url = new URL(req.url, "http://localhost");
		const { pathname } = url;
		const ip = clientIp(req);

		if (req.method === "GET" && pathname === "/favicon.ico") return send(res, 204, "");
		if (req.method === "GET" && pathname === "/api/v1/ping") return send(res, 200, { ok: true, service: "NYXARIS AUTH", ts: now() });
		const lm = pathname.match(/^\/files\/v1\/loaders\/([a-f0-9]{40})\.lua$/);
		if (req.method === "GET" && lm) return serveLoader(req, res, lm[1]);
		if (req.method === "POST" && pathname === "/api/v1/auth") return await handleAuth(req, res);

		if (pathname.startsWith("/admin/")) {
			for (const r of routes) {
				if (r.method !== req.method) continue;
				const m = pathname.match(r.re);
				if (!m) continue;

				let session = null;
				if (!r.public) {
					session = getSession(req);
					if (!session) return send(res, 401, { error: "Unauthorized" });
					// CSRF: state-changing requests must echo the per-session token.
					if (req.method !== "GET" && !safeEqual(req.headers["x-csrf-token"] || "", session.csrf)) {
						return send(res, 403, { error: "Bad CSRF token" });
					}
				}
				const body = req.method === "GET" || req.method === "DELETE" ? {} : await readJson(req);
				return await r.handler(req, res, { session, body, params: m.slice(1), query: url.searchParams, ip });
			}
			return send(res, 404, { error: "Not found" });
		}

		if (req.method === "GET") return serveStatic(req, res, pathname);
		send(res, 404, "Not found");
	} catch (e) {
		if (e.status) return send(res, e.status, { error: e.message });
		console.error(e);
		send(res, 500, { error: "Internal error" });
	}
});

server.listen(PORT, HOST, () => console.log(`NYXARIS AUTH listening on http://${HOST}:${PORT}`));
