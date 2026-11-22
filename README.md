# NYXARIS AUTH

Self-hosted script licensing. Node >= 22.5, SQLite (built-in `node:sqlite`), zero npm dependencies.

## Run
    cp .env.example .env
    npm start
First start prints the admin login (or uses ADMIN_USER / ADMIN_PASS). Open http://127.0.0.1:3000

## Production
- Put it behind HTTPS (Caddy/nginx/Cloudflare), set `TRUST_PROXY=1` and `COOKIE_SECURE=1`.
- Keep `HOST=127.0.0.1` and proxy to it. Back up `data/nyxaris.db`.

## Flow
1. Dashboard > Scripts > New script (paste Luau source). Click Loader, copy the CONFIG block into `loader/loader.lua`.
2. Keys > Generate keys. Give buyers the key + your loader.
3. Buyer runs: `script_key = "NYX-..."; loadstring(game:HttpGet("<your loader url>"))()`

## API
POST /api/v1/auth  {key, hwid, script, nonce, userId?, placeId?}
-> {ok, code, message, ts, nonce, sig, version, payload?, expiresAt?}
sig = HMAC-SHA256(scriptSecret, `nonce|ok(1/0)|code|ts|sha256(payload)`). Payload is only sent when ok.
Codes: OK, BAD_REQUEST, RATE_LIMITED, NO_SCRIPT, SCRIPT_DISABLED, BLACKLISTED, INVALID_KEY, KEY_BANNED, KEY_EXPIRED, HWID_MISMATCH.
GET /api/v1/ping

## Limits
Source is delivered to the client after auth, so a determined user can dump it at runtime. Obfuscate the payload (e.g. Luraph) and keep sensitive logic server-side where possible.

## Railway (auto-configured)
Upload/push, add a Volume (any mount path, e.g. /data), set ADMIN_PASS, Generate Domain. Host, DB path, proxy and secure-cookie settings are detected automatically.
