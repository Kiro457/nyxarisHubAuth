"use strict";

// NYXARIS AUTH dashboard. All dynamic content goes through textContent (no innerHTML).

const root = document.getElementById("app");
let csrf = "";
let username = "";
let tab = "overview";

function h(tag, attrs, ...kids) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs || {})) {
		if (k === "class") el.className = v;
		else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
		else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
	}
	for (const kid of kids.flat()) {
		if (kid == null || kid === false) continue;
		el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
	}
	return el;
}

async function api(method, url, body) {
	const res = await fetch(url, {
		method,
		headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
		body: body !== undefined ? JSON.stringify(body) : undefined,
		credentials: "same-origin",
	});
	let data = {};
	try { data = await res.json(); } catch {}
	if (res.status === 401 && url !== "/admin/login") { renderLogin(); throw new Error("Session expired"); }
	if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
	return data;
}

function toast(msg) {
	const t = h("div", { class: "toast" }, msg);
	document.body.append(t);
	setTimeout(() => t.remove(), 2600);
}

async function copy(text) {
	try { await navigator.clipboard.writeText(text); toast("Copied"); } catch { toast("Copy failed"); }
}

const fmt = (ts) => (ts ? new Date(ts * 1000).toLocaleString() : "-");

function modal(title, content, onClose) {
	const close = () => { m.remove(); onClose && onClose(); };
	const m = h("div", { class: "modal", onclick: (e) => e.target === m && close() },
		h("div", { class: "box" }, h("h3", {}, title), content, h("div", { class: "row", style: "margin-top:12px" }, h("button", { class: "btn g", onclick: close }, "Close"))));
	document.body.append(m);
	return close;
}

function table(headers, rows) {
	return h("div", { class: "wrap" }, h("table", {},
		h("thead", {}, h("tr", {}, headers.map((x) => h("th", {}, x)))),
		h("tbody", {}, rows.length ? rows : h("tr", {}, h("td", { colspan: headers.length }, "Nothing here yet")))));
}

// Login.
function renderLogin(err) {
	const u = h("input", { placeholder: "Username", autocomplete: "username" });
	const p = h("input", { placeholder: "Password", type: "password", autocomplete: "current-password" });
	const e = h("div", { class: "err" }, err || "");
	const go = async () => {
		try {
			const r = await api("POST", "/admin/login", { username: u.value, password: p.value });
			csrf = r.csrf; username = r.username;
			renderShell();
		} catch (x) { e.textContent = x.message; }
	};
	p.addEventListener("keydown", (ev) => ev.key === "Enter" && go());
	root.replaceChildren(h("div", { class: "login" },
		h("div", { class: "brand" }, "NYXARIS ", h("span", {}, "AUTH")),
		h("div", { class: "row", style: "margin-top:20px" }, u),
		h("div", { class: "row" }, p), e,
		h("button", { class: "btn", style: "width:100%", onclick: go }, "Sign in")));
}

// Shell.
const TABS = [["overview", "Overview"], ["scripts", "Scripts"], ["keys", "Keys"], ["blacklist", "Blacklist"], ["logs", "Logs"], ["account", "Account"]];

function renderShell() {
	const view = h("div", { class: "main" });
	const side = h("div", { class: "side" },
		h("div", { class: "brand" }, "NYX", h("span", {}, "ARIS")),
		TABS.map(([id, label]) => h("button", { class: "nav" + (id === tab ? " on" : ""), onclick: () => { tab = id; renderShell(); } }, label)),
		h("div", { class: "spacer" }),
		h("div", { class: "mono", style: "color:var(--mute);padding:0 10px" }, username),
		h("button", { class: "nav", onclick: async () => { await api("POST", "/admin/logout", {}); renderLogin(); } }, "Sign out"));
	root.replaceChildren(h("div", { class: "layout" }, side, view));
	const views = { overview, scripts, keys, blacklist, logs, account };
	views[tab](view).catch((x) => view.replaceChildren(h("div", { class: "err" }, x.message)));
}

// Overview.
async function overview(view) {
	const s = await api("GET", "/admin/stats");
	const items = [["Scripts", s.scripts], ["Keys", s.keys], ["Active keys", s.activeKeys], ["Banned keys", s.bannedKeys], ["Auths 24h", s.auths24h], ["Fails 24h", s.fails24h], ["Blacklisted", s.blacklist]];
	view.replaceChildren(h("h2", {}, "Overview"), h("div", { class: "cards" }, items.map(([l, n]) => h("div", { class: "card" }, h("div", { class: "n" }, n), h("div", { class: "l" }, l)))));
}

// Scripts.
async function scripts(view) {
	const list = await api("GET", "/admin/scripts");
	const rows = list.map((s) => h("tr", {},
		h("td", {}, s.name), h("td", { class: "mono" }, s.id), h("td", {}, "v" + s.version),
		h("td", {}, s.size + " B"), h("td", {}, s.keyCount),
		h("td", {}, h("span", { class: "tag " + (s.enabled ? "ok" : "bad") }, s.enabled ? "enabled" : "disabled")),
		h("td", {}, h("div", { class: "acts" },
			h("button", { class: "btn s", onclick: () => editScript(s.id) }, "Edit"),
			h("button", { class: "btn s g", onclick: () => loaderSnippet(s.id) }, "Loader"),
			h("button", { class: "btn s g", onclick: async () => { await api("PATCH", "/admin/scripts/" + s.id, { enabled: !s.enabled }); renderShell(); } }, s.enabled ? "Disable" : "Enable"),
			h("button", { class: "btn s d", onclick: async () => { if (confirm(`Delete "${s.name}" and ALL its keys?`)) { await api("DELETE", "/admin/scripts/" + s.id); renderShell(); } } }, "Delete")))));
	view.replaceChildren(h("h2", {}, "Scripts"),
		h("div", { class: "bar" }, h("button", { class: "btn", onclick: () => editScript(null) }, "+ New script")),
		table(["Name", "ID", "Ver", "Size", "Keys", "Status", ""], rows));
}

async function editScript(id) {
	const cur = id ? await api("GET", "/admin/scripts/" + id) : { name: "", source: "" };
	const name = h("input", { value: cur.name, placeholder: "Script name" });
	const src = h("textarea", { rows: 18, placeholder: "-- Paste your Luau source here" });
	src.value = cur.source;
	const file = h("input", { type: "file", accept: ".lua,.luau,.txt" });
	file.addEventListener("change", async () => { if (file.files[0]) src.value = await file.files[0].text(); });
	const err = h("div", { class: "err" });
	const close = modal(id ? "Edit script" : "New script", h("div", {},
		h("div", { class: "row" }, h("label", {}, "Name"), name),
		h("div", { class: "row" }, h("label", {}, "Load file"), file),
		src, err,
		h("div", { class: "row", style: "margin-top:10px" }, h("button", { class: "btn", onclick: async () => {
			try {
				if (id) await api("PATCH", "/admin/scripts/" + id, { name: name.value, source: src.value });
				else await api("POST", "/admin/scripts", { name: name.value, source: src.value });
				close(); renderShell();
			} catch (x) { err.textContent = x.message; }
		} }, "Save"))));
}

async function loaderSnippet(id) {
	const s = await api("GET", "/admin/scripts/" + id);
	const url = `${location.origin}/files/v1/loaders/${s.loaderId}.lua`;
	const text = `script_key = "KEY"; loadstring(game:HttpGet("${url}"))()`;
	modal("Loader: " + s.name, h("div", {},
		h("div", { class: "row" }, "Give this to your users (they replace KEY with their key):"),
		h("pre", {}, text),
		h("div", { class: "row", style: "margin-top:10px" },
			h("button", { class: "btn g", onclick: () => copy(text) }, "Copy"),
			h("button", { class: "btn g", onclick: async () => { if (confirm("Rotate secret? The old loader link stops working and a new one is generated.")) { await api("PATCH", "/admin/scripts/" + id, { rotateSecret: true }); toast("Rotated"); loaderSnippet(id); } } }, "Rotate secret"))));
}

// Keys.
async function keys(view) {
	const scr = await api("GET", "/admin/scripts");
	const fScript = h("select", {}, h("option", { value: "" }, "All scripts"), scr.map((s) => h("option", { value: s.id }, s.name)));
	const q = h("input", { placeholder: "Search key / note" });
	const body = h("div", {});
	const load = async () => {
		const p = new URLSearchParams();
		if (fScript.value) p.set("script", fScript.value);
		if (q.value) p.set("q", q.value);
		const list = await api("GET", "/admin/keys?" + p);
		const rows = list.map((k) => {
			const expired = k.expiresAt && k.expiresAt <= Date.now() / 1000;
			const st = k.status === "banned" ? ["bad", "banned"] : expired ? ["warn", "expired"] : ["ok", "active"];
			const act = (label, fn, cls = "g") => h("button", { class: "btn s " + cls, onclick: async () => { await fn(); load(); } }, label);
			return h("tr", {},
				h("td", { class: "mono", style: "cursor:pointer", title: "Copy", onclick: () => copy(k.key) }, k.key),
				h("td", {}, k.scriptName), h("td", {}, h("span", { class: "tag " + st[0] }, st[1])),
				h("td", {}, k.expiresAt ? fmt(k.expiresAt) : "Lifetime"),
				h("td", {}, `${k.hwidCount}/${k.maxHwids}`), h("td", {}, k.uses), h("td", {}, fmt(k.lastUsedAt)), h("td", {}, k.note),
				h("td", {}, h("div", { class: "acts" },
					act(k.status === "banned" ? "Unban" : "Ban", () => api("PATCH", "/admin/keys/" + k.id, { status: k.status === "banned" ? "active" : "banned" })),
					act("Reset HWID", () => api("PATCH", "/admin/keys/" + k.id, { resetHwid: true })),
					act("+30d", () => api("PATCH", "/admin/keys/" + k.id, { extendDays: 30 })),
					h("button", { class: "btn s g", onclick: () => showHwids(k) }, "HWIDs"),
					act("Delete", async () => { if (confirm("Delete this key?")) await api("DELETE", "/admin/keys/" + k.id); }, "d"))));
		});
		body.replaceChildren(table(["Key", "Script", "Status", "Expires", "HWIDs", "Uses", "Last used", "Note", ""], rows));
	};
	fScript.addEventListener("change", load);
	q.addEventListener("input", load);
	view.replaceChildren(h("h2", {}, "Keys"),
		h("div", { class: "bar" }, h("button", { class: "btn", onclick: () => generateKeys(scr, load) }, "+ Generate keys"), fScript, q), body);
	await load();
}

async function showHwids(k) {
	const list = await api("GET", `/admin/keys/${k.id}/hwids`);
	modal("HWIDs: " + k.key, table(["HWID", "First seen", "Last seen"], list.map((x) => h("tr", {}, h("td", { class: "mono" }, x.hwid), h("td", {}, fmt(x.firstSeen)), h("td", {}, fmt(x.lastSeen))))));
}

function generateKeys(scr, done) {
	if (!scr.length) return toast("Create a script first");
	const sel = h("select", {}, scr.map((s) => h("option", { value: s.id }, s.name)));
	const count = h("input", { type: "number", value: 1, min: 1, max: 500 });
	const days = h("input", { type: "number", value: 0, min: 0, placeholder: "0 = lifetime" });
	const hw = h("input", { type: "number", value: 1, min: 1, max: 20 });
	const note = h("input", { placeholder: "Note (buyer, order id...)" });
	const out = h("textarea", { rows: 8, readonly: true, style: "display:none" });
	const err = h("div", { class: "err" });
	modal("Generate keys", h("div", {},
		h("div", { class: "row" }, h("label", {}, "Script"), sel),
		h("div", { class: "row" }, h("label", {}, "Count"), count),
		h("div", { class: "row" }, h("label", {}, "Days"), days),
		h("div", { class: "row" }, h("label", {}, "Max HWIDs"), hw),
		h("div", { class: "row" }, h("label", {}, "Note"), note), err,
		h("button", { class: "btn", onclick: async () => {
			try {
				const r = await api("POST", "/admin/keys", { scriptId: sel.value, count: +count.value, durationDays: +days.value, maxHwids: +hw.value, note: note.value });
				out.style.display = "block"; out.value = r.keys.join("\n"); err.textContent = ""; done();
			} catch (x) { err.textContent = x.message; }
		} }, "Generate"), h("div", { style: "height:10px" }), out), done);
}

// Blacklist.
async function blacklist(view) {
	const list = await api("GET", "/admin/blacklist");
	const type = h("select", {}, h("option", { value: "hwid" }, "HWID"), h("option", { value: "ip" }, "IP"));
	const val = h("input", { placeholder: "Value" });
	const reason = h("input", { placeholder: "Reason" });
	view.replaceChildren(h("h2", {}, "Blacklist"),
		h("div", { class: "bar" }, type, val, reason, h("button", { class: "btn", onclick: async () => { try { await api("POST", "/admin/blacklist", { type: type.value, value: val.value, reason: reason.value }); renderShell(); } catch (x) { toast(x.message); } } }, "Add")),
		table(["Type", "Value", "Reason", "Added", ""], list.map((b) => h("tr", {}, h("td", {}, b.type), h("td", { class: "mono" }, b.value), h("td", {}, b.reason), h("td", {}, fmt(b.createdAt)),
			h("td", {}, h("button", { class: "btn s g", onclick: async () => { await api("DELETE", "/admin/blacklist/" + b.id); renderShell(); } }, "Remove"))))));
}

// Logs.
async function logs(view) {
	const res = h("select", {}, h("option", { value: "" }, "All results"), ["OK", "INVALID_KEY", "KEY_BANNED", "KEY_EXPIRED", "HWID_MISMATCH", "BLACKLISTED", "RATE_LIMITED", "NO_SCRIPT", "SCRIPT_DISABLED"].map((r) => h("option", { value: r }, r)));
	const body = h("div", {});
	const load = async () => {
		const list = await api("GET", "/admin/logs" + (res.value ? "?result=" + res.value : ""));
		body.replaceChildren(table(["Time", "Result", "Key", "HWID", "IP", "User", "Place", "Detail"], list.map((l) => h("tr", {},
			h("td", {}, fmt(l.ts)), h("td", {}, h("span", { class: "tag " + (l.result === "OK" ? "ok" : "bad") }, l.result)),
			h("td", { class: "mono" }, l.keyValue || "-"), h("td", { class: "mono" }, (l.hwid || "-").slice(0, 16)), h("td", { class: "mono" }, l.ip || "-"),
			h("td", {}, l.userId || "-"), h("td", {}, l.placeId || "-"), h("td", {}, l.detail)))));
	};
	res.addEventListener("change", load);
	view.replaceChildren(h("h2", {}, "Logs"), h("div", { class: "bar" }, res,
		h("button", { class: "btn g", onclick: load }, "Refresh"),
		h("button", { class: "btn d", onclick: async () => { if (confirm("Clear all logs?")) { await api("DELETE", "/admin/logs"); load(); } } }, "Clear")), body);
	await load();
}

// Account.
async function account(view) {
	const cur = h("input", { type: "password", placeholder: "Current password" });
	const nxt = h("input", { type: "password", placeholder: "New password (10+ chars)" });
	const err = h("div", { class: "err" });
	view.replaceChildren(h("h2", {}, "Account"), h("div", { class: "card", style: "max-width:380px" },
		h("div", { class: "row" }, cur), h("div", { class: "row" }, nxt), err,
		h("button", { class: "btn", onclick: async () => { try { await api("POST", "/admin/password", { current: cur.value, next: nxt.value }); toast("Password changed"); cur.value = nxt.value = ""; err.textContent = ""; } catch (x) { err.textContent = x.message; } } }, "Change password")));
}

// Boot.
(async () => {
	try {
		const me = await fetch("/admin/me", { credentials: "same-origin" });
		if (!me.ok) return renderLogin();
		const d = await me.json();
		csrf = d.csrf; username = d.username;
		renderShell();
	} catch { renderLogin(); }
})();
