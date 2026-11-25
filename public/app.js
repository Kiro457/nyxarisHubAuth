"use strict";

// NYXARIS AUTH dashboard. All dynamic content goes through textContent (no innerHTML).

const root = document.getElementById("app");
const state = { csrf: "", username: "", page: "dashboard", script: "", scripts: [], users: { q: "", status: "", page: 0, limit: 15 } };

// DOM helpers.
function h(tag, attrs, ...kids) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs || {})) {
		if (k === "class") el.className = v;
		else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
		else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
	}
	for (const kid of kids.flat(Infinity)) {
		if (kid == null || kid === false) continue;
		el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
	}
	return el;
}

const NS = "http://www.w3.org/2000/svg";
function svg(tag, attrs, ...kids) {
	const el = document.createElementNS(NS, tag);
	for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
	for (const kid of kids.flat(Infinity)) if (kid != null) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
	return el;
}

const ICONS = {
	grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
	code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
	users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
	shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
	list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r=".6"/><circle cx="3.5" cy="12" r=".6"/><circle cx="3.5" cy="18" r=".6"/>',
	user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
	out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
	plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
	copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
	search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
	more: '<circle cx="12" cy="5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="19" r="1.2"/>',
	check: '<polyline points="20 6 9 17 4 12"/>',
	x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
	zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
	key: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
	refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
	trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
	ban: '<circle cx="12" cy="12" r="10"/><line x1="4.9" y1="4.9" x2="19.1" y2="19.1"/>',
	cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>',
	clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
	edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
};

function icon(name, size = 17) {
	const el = svg("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" });
	// Static, trusted path data only.
	el.innerHTML = ICONS[name] || "";
	return el;
}

async function api(method, url, body) {
	const res = await fetch(url, {
		method,
		headers: { "Content-Type": "application/json", "X-CSRF-Token": state.csrf },
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
	setTimeout(() => t.remove(), 2400);
}

async function copy(text) {
	try { await navigator.clipboard.writeText(text); toast("Copied to clipboard"); } catch { toast("Copy failed"); }
}

const fmt = (ts) => (ts ? new Date(ts * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "-");
function ago(ts) {
	if (!ts) return "never";
	const d = Math.max(0, Math.floor(Date.now() / 1000 - ts));
	if (d < 60) return d + "s ago";
	if (d < 3600) return Math.floor(d / 60) + "m ago";
	if (d < 86400) return Math.floor(d / 3600) + "h ago";
	return Math.floor(d / 86400) + "d ago";
}
const num = (n) => Number(n || 0).toLocaleString();
const pill = (cls, text) => h("span", { class: "pill " + cls }, text);

function modal(title, hint, content, opts = {}) {
	const close = () => { m.remove(); opts.onClose && opts.onClose(); };
	const m = h("div", { class: "modal", onmousedown: (e) => e.target === m && close() },
		h("div", { class: "box" + (opts.small ? " sm" : "") }, h("h3", {}, title), hint ? h("p", { class: "hint" }, hint) : null, content));
	document.body.append(m);
	return close;
}

// Floating row-action menu.
let openMenu = null;
function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }
document.addEventListener("click", closeMenu);
function menuButton(items) {
	return h("button", { class: "btn g ic", onclick: (e) => {
		e.stopPropagation();
		const had = openMenu;
		closeMenu();
		if (had) return;
		const r = e.currentTarget.getBoundingClientRect();
		const m = h("div", { class: "menu" }, items.map((it) => it === "-" ? h("hr") : h("button", { class: it.danger ? "d" : "", onclick: () => { closeMenu(); it.run(); } }, icon(it.icon, 15), it.label)));
		document.body.append(m);
		const top = r.bottom + 6 + m.offsetHeight > innerHeight ? r.top - m.offsetHeight - 6 : r.bottom + 6;
		m.style.top = Math.max(8, top) + "px";
		m.style.left = Math.max(8, Math.min(innerWidth - m.offsetWidth - 8, r.right - m.offsetWidth)) + "px";
		openMenu = m;
	} }, icon("more", 16));
}

function table(headers, rows, emptyText = "Nothing here yet") {
	return h("div", { class: "wrap" }, h("table", {},
		h("thead", {}, h("tr", {}, headers.map((x) => h("th", {}, x)))),
		h("tbody", {}, rows.length ? rows : h("tr", {}, h("td", { colspan: headers.length, class: "empty" }, emptyText)))));
}

function switchBtn(on, onToggle) {
	return h("button", { class: "switch" + (on ? " on" : ""), title: on ? "Enabled" : "Disabled", onclick: onToggle });
}

// Login.
function renderLogin(err) {
	const u = h("input", { placeholder: "Username", autocomplete: "username", style: "width:100%" });
	const p = h("input", { placeholder: "Password", type: "password", autocomplete: "current-password", style: "width:100%" });
	const e = h("div", { class: "err" }, err || "");
	const go = async () => {
		try {
			const r = await api("POST", "/admin/login", { username: u.value, password: p.value });
			state.csrf = r.csrf; state.username = r.username;
			await boot();
		} catch (x) { e.textContent = x.message; }
	};
	p.addEventListener("keydown", (ev) => ev.key === "Enter" && go());
	root.replaceChildren(h("div", { class: "loginWrap" }, h("div", { class: "login" },
		h("div", { class: "logo" }, h("div", { class: "logoMark" }, "N"), "NYXARIS AUTH"),
		h("h1", {}, "Welcome back"), h("p", {}, "Sign in to manage your scripts and users."),
		h("div", { class: "row" }, u), h("div", { class: "row" }, p), e,
		h("button", { class: "btn", style: "width:100%;justify-content:center", onclick: go }, "Sign in"))));
}

// Shell.
const NAV = [
	["Main", [["dashboard", "Dashboard", "grid"], ["scripts", "Scripts", "code"], ["users", "Users", "users"]]],
	["Security", [["blacklist", "Blacklist", "shield"], ["logs", "Execution logs", "list"]]],
	["Account", [["settings", "Settings", "user"]]],
];
const TITLES = { dashboard: "Dashboard", scripts: "Scripts", users: "Users", blacklist: "Blacklist", logs: "Execution logs", settings: "Settings" };

function go(page) { state.page = page; renderShell(); }

async function loadScripts() { state.scripts = await api("GET", "/admin/scripts"); }

function renderShell() {
	const view = h("div", { class: "main" });
	const projectSel = h("select", { onchange: (e) => { state.script = e.target.value; state.users.page = 0; renderShell(); } },
		h("option", { value: "" }, "All scripts"),
		state.scripts.map((s) => h("option", { value: s.id, selected: s.id === state.script }, s.name)));
	const filterable = ["dashboard", "users", "logs"].includes(state.page);

	const side = h("div", { class: "side" },
		h("div", { class: "logo" }, h("div", { class: "logoMark" }, "N"), "NYXARIS"),
		NAV.map(([sec, items]) => [h("div", { class: "sec" }, sec), items.map(([id, label, ic]) => h("button", { class: "nav" + (id === state.page ? " on" : ""), onclick: () => go(id) }, icon(ic), label))]),
		h("div", { class: "grow" }),
		h("div", { class: "me" }, h("div", { class: "avatar" }, state.username.slice(0, 1).toUpperCase()),
			h("div", { class: "grow" }, h("div", { class: "n" }, state.username), h("div", { class: "r" }, "Administrator")),
			h("button", { class: "btn g ic", title: "Sign out", onclick: async () => { await api("POST", "/admin/logout", {}); renderLogin(); } }, icon("out", 15))));

	const top = h("div", { class: "top" },
		h("h1", {}, TITLES[state.page]), h("span", { class: "grow" }),
		filterable ? projectSel : null,
		h("button", { class: "btn g ic", title: "Refresh", onclick: () => renderShell() }, icon("refresh", 16)));

	root.replaceChildren(h("div", { class: "app" }, side, h("div", { class: "content" }, top, view)));
	const pages = { dashboard, scripts, users, blacklist, logs, settings };
	pages[state.page](view).catch((x) => view.replaceChildren(h("div", { class: "err" }, x.message)));
}

// Dashboard.
function statCard(ico, cls, value, label) {
	return h("div", { class: "card stat" }, h("div", { class: "ico " + cls }, icon(ico, 20)), h("div", {}, h("div", { class: "v" }, num(value)), h("div", { class: "l" }, label)));
}

function chart(data) {
	const W = 720, H = 230, padL = 34, padB = 24, padT = 10;
	const max = Math.max(4, ...data.map((d) => d.ok + d.fail));
	const niceMax = Math.ceil(max / 4) * 4;
	const iw = W - padL - 6, ih = H - padB - padT;
	const bw = iw / data.length;
	const el = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", class: "chart" });
	for (let i = 0; i <= 4; i++) {
		const y = padT + ih - (ih * i) / 4;
		el.append(svg("line", { x1: padL, x2: W - 6, y1: y, y2: y, stroke: "#222633", "stroke-width": 1 }), svg("text", { x: padL - 6, y: y + 3, "text-anchor": "end" }, Math.round((niceMax * i) / 4)));
	}
	data.forEach((d, i) => {
		const x = padL + i * bw + bw * 0.18, w = bw * 0.64;
		const hOk = (d.ok / niceMax) * ih, hFail = (d.fail / niceMax) * ih;
		const g = svg("g", {}, svg("title", {}, `${d.day}\nSuccessful: ${d.ok}\nFailed: ${d.fail}`));
		if (hOk > 0) g.append(svg("rect", { x, y: padT + ih - hOk, width: w, height: hOk, rx: 3, fill: "#6366f1" }));
		if (hFail > 0) g.append(svg("rect", { x, y: padT + ih - hOk - hFail, width: w, height: hFail, rx: 3, fill: "#f87171" }));
		g.append(svg("rect", { x: padL + i * bw, y: padT, width: bw, height: ih, fill: "transparent" }));
		el.append(g);
		if (i % 2 === (data.length - 1) % 2) el.append(svg("text", { x: x + w / 2, y: H - 7, "text-anchor": "middle" }, d.day.slice(5)));
	});
	return el;
}

async function dashboard(view) {
	const q = state.script ? "?script=" + state.script : "";
	const [s, c, recent] = await Promise.all([
		api("GET", "/admin/stats" + q),
		api("GET", "/admin/chart" + (state.script ? q + "&days=14" : "?days=14")),
		api("GET", "/admin/logs?limit=8" + (state.script ? "&script=" + state.script : "")),
	]);
	const feed = recent.length ? recent.map((l) => h("div", { class: "feedRow" },
		h("span", { class: "dot " + (l.result === "OK" ? "ok" : "bad") }),
		h("div", { class: "m" }, h("div", { class: "mono" }, l.keyValue || l.result), h("div", { class: "sub" }, l.result === "OK" ? "Executed" : l.result.replace(/_/g, " ").toLowerCase(), " · ", l.userId ? "user " + l.userId : (l.ip || "-"))),
		h("span", { class: "sub" }, ago(l.ts)))) : h("div", { class: "sub", style: "padding:20px 0;text-align:center" }, "No executions yet");

	view.replaceChildren(
		h("div", { class: "grid stats" },
			statCard("users", "", s.keys, "Total users"),
			statCard("check", "ok", s.activeKeys, "Active users"),
			statCard("zap", "info", s.totalExecs, "Total executions"),
			statCard("clock", "ok", s.auths24h, "Executions (24h)"),
			statCard("x", "bad", s.fails24h, "Failed attempts (24h)"),
			statCard("ban", "warn", s.bannedKeys, "Banned users")),
		h("div", { class: "cols" },
			h("div", { class: "card" }, h("div", { class: "cardHead" }, h("h3", {}, "Executions · last 14 days"),
				h("div", { class: "legend" }, h("span", {}, h("i", { style: "background:#6366f1" }), "Successful"), h("span", {}, h("i", { style: "background:#f87171" }), "Failed"))), chart(c)),
			h("div", { class: "card" }, h("div", { class: "cardHead" }, h("h3", {}, "Recent activity"), h("button", { class: "btn g s", onclick: () => go("logs") }, "View all")), h("div", { class: "feed" }, feed))));
}

// Scripts.
async function scripts(view) {
	await loadScripts();
	const cards = state.scripts.map((s) => h("div", { class: "card sc" },
		h("div", { class: "top2" }, h("div", { class: "ico" }, icon("code", 20)),
			h("div", { class: "grow", style: "min-width:0" }, h("div", { class: "nm" }, s.name), h("div", { class: "sub mono" }, s.id)),
			switchBtn(!!s.enabled, async () => { await api("PATCH", "/admin/scripts/" + s.id, { enabled: !s.enabled }); renderShell(); })),
		h("div", { class: "meta" }, h("div", {}, h("b", {}, "v" + s.version), h("span", {}, "Version")), h("div", {}, h("b", {}, num(s.keyCount)), h("span", {}, "Users")), h("div", {}, h("b", {}, (s.size / 1024).toFixed(1) + " KB"), h("span", {}, "Size"))),
		h("div", { class: "acts" },
			h("button", { class: "btn s", onclick: () => loaderSnippet(s.id) }, icon("copy", 14), "Get loader"),
			h("button", { class: "btn g s", onclick: () => editScript(s.id) }, icon("edit", 14), "Edit"),
			h("button", { class: "btn g s", onclick: () => { state.script = s.id; go("users"); } }, icon("users", 14), "Users"),
			h("button", { class: "btn d s", onclick: async () => { if (confirm(`Delete "${s.name}" and ALL its users?`)) { await api("DELETE", "/admin/scripts/" + s.id); renderShell(); } } }, icon("trash", 14)))));
	view.replaceChildren(
		h("div", { class: "bar" }, h("div", { class: "sub" }, `${state.scripts.length} script${state.scripts.length === 1 ? "" : "s"}`), h("span", { class: "sp" }),
			h("button", { class: "btn", onclick: () => editScript(null) }, icon("plus", 16), "Create script")),
		cards.length ? h("div", { class: "grid scripts" }, cards) : h("div", { class: "card empty" }, "No scripts yet. Create your first script to get started."));
}

async function editScript(id) {
	const cur = id ? await api("GET", "/admin/scripts/" + id) : { name: "", source: "" };
	const name = h("input", { value: cur.name, placeholder: "Script name" });
	const src = h("textarea", { rows: 16, placeholder: "-- Paste your Luau source here" });
	src.value = cur.source;
	const file = h("input", { type: "file", accept: ".lua,.luau,.txt" });
	file.addEventListener("change", async () => { if (file.files[0]) src.value = await file.files[0].text(); });
	const err = h("div", { class: "err" });
	let close;
	close = modal(id ? "Edit script" : "Create script", "This source is only delivered to users with a valid key.", h("div", {},
		h("div", { class: "row" }, h("label", {}, "Name"), name),
		h("div", { class: "row" }, h("label", {}, "Upload"), file),
		src, err,
		h("div", { class: "foot" }, h("button", { class: "btn g", onclick: () => close() }, "Cancel"), h("button", { class: "btn", onclick: async () => {
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
	let close;
	close = modal("Loader · " + s.name, "Give users this snippet. They replace KEY with their own key.", h("div", {},
		h("pre", {}, text),
		h("div", { class: "foot" },
			h("button", { class: "btn d", onclick: async () => { if (confirm("Rotate secret? The old loader link stops working.")) { await api("PATCH", "/admin/scripts/" + id, { rotateSecret: true }); toast("Secret rotated"); close(); loaderSnippet(id); } } }, "Rotate secret"),
			h("button", { class: "btn g", onclick: () => close() }, "Close"),
			h("button", { class: "btn", onclick: () => copy(text) }, icon("copy", 15), "Copy"))));
}

// Users.
async function users(view) {
	if (!state.scripts.length) await loadScripts();
	const st = state.users;
	const tableBox = h("div", {});
	const pager = h("div", { class: "pager" });
	const search = h("input", { placeholder: "Search key or note...", value: st.q });
	let timer;
	search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { st.q = search.value; st.page = 0; load(); }, 250); });
	const tabs = h("div", { class: "tabs" }, [["", "All"], ["active", "Active"], ["expired", "Expired"], ["banned", "Banned"]].map(([v, l]) =>
		h("button", { class: st.status === v ? "on" : "", onclick: (e) => { st.status = v; st.page = 0; tabs.querySelectorAll("button").forEach((b) => b.classList.remove("on")); e.currentTarget.classList.add("on"); load(); } }, l)));

	const load = async () => {
		const p = new URLSearchParams({ limit: st.limit, offset: st.page * st.limit });
		if (state.script) p.set("script", state.script);
		if (st.q) p.set("q", st.q);
		if (st.status) p.set("status", st.status);
		const { rows, total } = await api("GET", "/admin/keys?" + p);
		const trs = rows.map((k) => {
			const expired = k.expiresAt && k.expiresAt <= Date.now() / 1000;
			const status = k.status === "banned" ? pill("bad", "Banned") : expired ? pill("warn", "Expired") : pill("ok", "Active");
			const refresh = async (fn) => { await fn(); load(); };
			return h("tr", {},
				h("td", {}, h("span", { class: "copyable mono", title: "Click to copy", onclick: () => copy(k.key) }, k.key, icon("copy", 13))),
				h("td", {}, k.note || h("span", { class: "sub" }, "-")),
				h("td", {}, k.scriptName), h("td", {}, status),
				h("td", {}, h("span", { class: "mono" }, `${k.hwidCount}/${k.maxHwids}`)),
				h("td", {}, num(k.uses)), h("td", { title: fmt(k.lastUsedAt) }, ago(k.lastUsedAt)),
				h("td", {}, k.expiresAt ? fmt(k.expiresAt) : pill("", "Lifetime")),
				h("td", {}, menuButton([
					{ icon: "copy", label: "Copy key", run: () => copy(k.key) },
					{ icon: "cpu", label: "View HWIDs", run: () => showHwids(k) },
					{ icon: "refresh", label: "Reset HWID", run: () => refresh(() => api("PATCH", "/admin/keys/" + k.id, { resetHwid: true })) },
					{ icon: "edit", label: "Edit note", run: () => editNote(k, load) },
					{ icon: "clock", label: "Extend +30 days", run: () => refresh(() => api("PATCH", "/admin/keys/" + k.id, { extendDays: 30 })) },
					{ icon: "clock", label: "Make lifetime", run: () => refresh(() => api("PATCH", "/admin/keys/" + k.id, { lifetime: true })) },
					"-",
					{ icon: "ban", label: k.status === "banned" ? "Unban user" : "Ban user", run: () => refresh(() => api("PATCH", "/admin/keys/" + k.id, { status: k.status === "banned" ? "active" : "banned" })) },
					{ icon: "trash", label: "Delete user", danger: true, run: async () => { if (confirm("Delete this user?")) refresh(() => api("DELETE", "/admin/keys/" + k.id)); } },
				])));
		});
		tableBox.replaceChildren(table(["Key", "Note", "Script", "Status", "HWID", "Executions", "Last execution", "Expires", ""], trs, "No users match your filters"));
		const pages = Math.max(1, Math.ceil(total / st.limit));
		pager.replaceChildren(h("span", {}, `${num(total)} user${total === 1 ? "" : "s"} · page ${st.page + 1} of ${pages}`),
			h("div", { class: "b" },
				h("button", { class: "btn g s", disabled: st.page === 0, onclick: () => { st.page--; load(); } }, "Previous"),
				h("button", { class: "btn g s", disabled: st.page + 1 >= pages, onclick: () => { st.page++; load(); } }, "Next")));
	};

	view.replaceChildren(
		h("div", { class: "bar" }, h("div", { class: "search" }, icon("search", 15), search), tabs, h("span", { class: "sp" }),
			h("button", { class: "btn", onclick: () => whitelist(load) }, icon("plus", 16), "Whitelist users")),
		tableBox, pager);
	await load();
}

async function editNote(k, done) {
	const note = h("input", { value: k.note, placeholder: "Note (buyer, discord, order id...)" });
	let close;
	close = modal("Edit note", k.key, h("div", {}, h("div", { class: "row" }, note), h("div", { class: "foot" },
		h("button", { class: "btn g", onclick: () => close() }, "Cancel"),
		h("button", { class: "btn", onclick: async () => { await api("PATCH", "/admin/keys/" + k.id, { note: note.value }); close(); done(); } }, "Save"))), { small: true });
}

async function showHwids(k) {
	const list = await api("GET", `/admin/keys/${k.id}/hwids`);
	let close;
	close = modal("Bound devices", k.key, h("div", {}, table(["HWID", "First seen", "Last seen"], list.map((x) => h("tr", {}, h("td", { class: "mono" }, x.hwid), h("td", {}, fmt(x.firstSeen)), h("td", {}, ago(x.lastSeen)))), "No device bound yet"),
		h("div", { class: "foot" }, h("button", { class: "btn g", onclick: () => close() }, "Close"))));
}

function whitelist(done) {
	if (!state.scripts.length) return toast("Create a script first");
	const sel = h("select", {}, state.scripts.map((s) => h("option", { value: s.id, selected: s.id === state.script }, s.name)));
	const count = h("input", { type: "number", value: 1, min: 1, max: 500 });
	const days = h("input", { type: "number", value: 0, min: 0, placeholder: "0 = lifetime" });
	const hw = h("input", { type: "number", value: 1, min: 1, max: 20 });
	const note = h("input", { placeholder: "Note (buyer, discord, order id...)" });
	const out = h("textarea", { rows: 7, readonly: true });
	const outBox = h("div", { style: "display:none;margin-top:14px" }, h("div", { class: "sub", style: "margin-bottom:6px" }, "Generated keys"), out);
	const err = h("div", { class: "err" });
	let close;
	close = modal("Whitelist users", "Generate one or many keys for a script.", h("div", {},
		h("div", { class: "row" }, h("label", {}, "Script"), sel),
		h("div", { class: "row" }, h("label", {}, "Amount"), count),
		h("div", { class: "row" }, h("label", {}, "Duration (days)"), days),
		h("div", { class: "row" }, h("label", {}, "Max devices"), hw),
		h("div", { class: "row" }, h("label", {}, "Note"), note), err,
		h("div", { class: "foot" },
			h("button", { class: "btn g", onclick: () => close() }, "Close"),
			h("button", { class: "btn", onclick: async () => {
				try {
					const r = await api("POST", "/admin/keys", { scriptId: sel.value, count: +count.value, durationDays: +days.value, maxHwids: +hw.value, note: note.value });
					out.value = r.keys.join("\n"); outBox.style.display = "block"; err.textContent = ""; done();
					copy(r.keys.join("\n"));
				} catch (x) { err.textContent = x.message; }
			} }, "Generate")), outBox), { onClose: done });
}

// Blacklist.
async function blacklist(view) {
	const list = await api("GET", "/admin/blacklist");
	const type = h("select", {}, h("option", { value: "hwid" }, "HWID"), h("option", { value: "ip" }, "IP address"));
	const val = h("input", { placeholder: "Value", style: "min-width:260px" });
	const reason = h("input", { placeholder: "Reason (optional)" });
	view.replaceChildren(
		h("div", { class: "bar" }, type, val, reason, h("button", { class: "btn", onclick: async () => { try { await api("POST", "/admin/blacklist", { type: type.value, value: val.value, reason: reason.value }); renderShell(); } catch (x) { toast(x.message); } } }, icon("ban", 15), "Blacklist")),
		table(["Type", "Value", "Reason", "Added", ""], list.map((b) => h("tr", {}, h("td", {}, pill("bad", b.type.toUpperCase())), h("td", { class: "mono" }, b.value), h("td", {}, b.reason || "-"), h("td", {}, fmt(b.createdAt)),
			h("td", {}, h("button", { class: "btn g s", onclick: async () => { await api("DELETE", "/admin/blacklist/" + b.id); renderShell(); } }, "Remove")))), "Nobody is blacklisted"));
}

// Logs.
async function logs(view) {
	const res = h("select", {}, h("option", { value: "" }, "All results"), ["OK", "INVALID_KEY", "KEY_BANNED", "KEY_EXPIRED", "HWID_MISMATCH", "BLACKLISTED", "RATE_LIMITED", "NO_SCRIPT", "SCRIPT_DISABLED"].map((r) => h("option", { value: r }, r.replace(/_/g, " "))));
	const body = h("div", {});
	const load = async () => {
		const p = new URLSearchParams({ limit: 200 });
		if (res.value) p.set("result", res.value);
		if (state.script) p.set("script", state.script);
		const list = await api("GET", "/admin/logs?" + p);
		body.replaceChildren(table(["Time", "Result", "Key", "HWID", "IP", "Roblox user", "Place", "Detail"], list.map((l) => h("tr", {},
			h("td", { title: fmt(l.ts) }, ago(l.ts)), h("td", {}, pill(l.result === "OK" ? "ok" : "bad", l.result.replace(/_/g, " "))),
			h("td", { class: "mono" }, l.keyValue || "-"), h("td", { class: "mono" }, (l.hwid || "-").slice(0, 14)), h("td", { class: "mono" }, l.ip || "-"),
			h("td", {}, l.userId || "-"), h("td", {}, l.placeId || "-"), h("td", {}, l.detail || ""))), "No logs yet"));
	};
	res.addEventListener("change", load);
	view.replaceChildren(h("div", { class: "bar" }, res, h("span", { class: "sp" }),
		h("button", { class: "btn d", onclick: async () => { if (confirm("Clear all logs?")) { await api("DELETE", "/admin/logs"); load(); } } }, icon("trash", 15), "Clear logs")), body);
	await load();
}

// Settings.
async function settings(view) {
	const cur = h("input", { type: "password", placeholder: "Current password", style: "width:100%" });
	const nxt = h("input", { type: "password", placeholder: "New password (10+ characters)", style: "width:100%" });
	const err = h("div", { class: "err" });
	const endpoint = `${location.origin}/api/v1/auth`;
	view.replaceChildren(h("div", { class: "grid", style: "grid-template-columns:repeat(auto-fit,minmax(320px,1fr));max-width:900px" },
		h("div", { class: "card" }, h("div", { class: "cardHead" }, h("h3", {}, "Change password")),
			h("div", { class: "row" }, cur), h("div", { class: "row" }, nxt), err,
			h("button", { class: "btn", onclick: async () => { try { await api("POST", "/admin/password", { current: cur.value, next: nxt.value }); toast("Password changed"); cur.value = nxt.value = ""; err.textContent = ""; } catch (x) { err.textContent = x.message; } } }, "Update password")),
		h("div", { class: "card" }, h("div", { class: "cardHead" }, h("h3", {}, "API endpoint")),
			h("p", { class: "sub", style: "margin-top:0" }, "Used by your loaders to authenticate keys."),
			h("pre", {}, endpoint), h("div", { class: "foot" }, h("button", { class: "btn g", onclick: () => copy(endpoint) }, icon("copy", 15), "Copy")))));
}

// Boot.
async function boot() {
	await loadScripts();
	renderShell();
}

(async () => {
	try {
		const me = await fetch("/admin/me", { credentials: "same-origin" });
		if (!me.ok) return renderLogin();
		const d = await me.json();
		state.csrf = d.csrf; state.username = d.username;
		await boot();
	} catch { renderLogin(); }
})();
