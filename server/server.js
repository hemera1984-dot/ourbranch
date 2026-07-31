// 하랑지점(ourbranch) API 서버
//
// 원칙: 차단은 서버가 한다. 열람 범위(자기 팀 / 지점 전체)는 브라우저가 아니라
// 여기서 가른다. 인증은 마이가디언 세션 공유(auth.js) — 로그인 화면은 마이가디언
// 것을 쓰고, 이 서버는 토큰만 검증한다.
//
// 외부 패키지를 쓰지 않는다 (Node 22+ 내장 http·sqlite).

import { createServer } from "node:http";
import { openDb, getSetting, getMember } from "./db.js";
import { openAuthDb, accountForToken } from "./auth.js";

const PORT = Number(process.env.PORT || 8788);
const DB_FILE = process.env.DB_FILE || "./ourbranch.db";
const AUTH_DB_FILE = process.env.AUTH_DB_FILE || "../myguardian-server/myguardian.db";
const ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);

const db = openDb(DB_FILE);
const authDb = openAuthDb(AUTH_DB_FILE);

const now = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

// ---------- HTTP 도우미 ----------

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error("bad json")); } });
    req.on("error", reject);
  });
}

// ---------- 권한 ----------
//
// 사용자(user) = 마이가디언 계정 + ourbranch 소속 정보.
// - super: 마이가디언 총관리자 (is_admin)
// - manager: 관리자 — 팀원 추가·삭제, 조직도 수정. 부지점장 이상 기본, 총관리자가 토글.
// - 열람 범위: super·지점장(BM)·can_view_all → 지점 전체 / 그 외 → 자기 팀

function userFor(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  const acc = accountForToken(authDb, m ? m[1] : null);
  if (!acc) return null;
  const email = acc.email.toLowerCase();
  const member = getMember(db, email);
  const isSuper = !!acc.is_admin;
  const gradeManager = acc.grade === "BM" || acc.grade === "ESL";
  return {
    email,
    name: acc.name,
    grade: acc.grade,
    teamId: member ? member.team_id : null,
    isSuper,
    isManager: isSuper || gradeManager || !!(member && member.is_manager),
    seesAll: isSuper || acc.grade === "BM" || !!(member && member.can_view_all)
  };
}

// 열람 가능한 team_id 조건절 (지점 공통 = NULL은 항상 포함하는 쪽에서 처리)
function canSeeTeam(user, teamId) {
  if (teamId == null) return true;
  return user.seesAll || user.teamId === teamId;
}

// ---------- 라우팅 ----------

const routes = [];
function route(method, pattern, needManager, handler) {
  routes.push({ method, pattern, needManager, handler });
}

// 앱 셸 부트스트랩 — 지점명·팀·구성원·내 권한을 한 번에
route("GET", /^\/bootstrap$/, false, (req, res, user) => {
  const teams = db.prepare("SELECT * FROM teams ORDER BY id").all();
  const members = db.prepare("SELECT email, name, team_id, role, is_manager, can_view_all FROM members ORDER BY team_id, name").all()
    .filter(m => canSeeTeam(user, m.team_id));
  send(res, 200, {
    branchName: getSetting(db, "지점명") || "",
    me: user,
    teams: user.seesAll ? teams : teams.filter(t => t.id === user.teamId),
    members
  });
});

// ---- 공지 ----
route("GET", /^\/notices$/, false, (req, res, user) => {
  const list = db.prepare("SELECT * FROM notices ORDER BY created DESC, id DESC").all()
    .filter(n => canSeeTeam(user, n.team_id))
    .map(n => ({
      ...n, body: JSON.parse(n.body),
      comments: db.prepare("SELECT * FROM comments WHERE notice_id = ? ORDER BY id").all(n.id)
    }));
  send(res, 200, list);
});

route("POST", /^\/notices$/, true, async (req, res, user) => {
  const b = await readJson(req);
  if (!b.title) return send(res, 400, { error: "제목이 없습니다" });
  const teamId = b.teamId ?? null;                       // null = 지점 공통
  if (teamId != null && !canSeeTeam(user, teamId)) return send(res, 403, { error: "권한 없음" });
  const r = db.prepare("INSERT INTO notices (team_id, kind, title, body, author, created) VALUES (?, ?, ?, ?, ?, ?)")
    .run(teamId, b.kind || "공지", b.title, JSON.stringify(b.body || []), user.name, now());
  send(res, 200, { id: Number(r.lastInsertRowid) });
});

// 댓글은 열람 가능한 공지에 누구나
route("POST", /^\/notices\/(\d+)\/comments$/, false, async (req, res, user, m) => {
  const n = db.prepare("SELECT * FROM notices WHERE id = ?").get(Number(m[1]));
  if (!n || !canSeeTeam(user, n.team_id)) return send(res, 403, { error: "권한 없음" });
  const b = await readJson(req);
  if (!b.content) return send(res, 400, { error: "내용이 없습니다" });
  db.prepare("INSERT INTO comments (notice_id, author, content, created) VALUES (?, ?, ?, ?)")
    .run(n.id, user.name, b.content, now());
  send(res, 200, { ok: true });
});

// ---- 일정 ----
route("GET", /^\/events$/, false, (req, res, user) => {
  const q = new URL(req.url, "http://x").searchParams;
  const from = q.get("from") || today(), to = q.get("to") || today();
  const list = db.prepare("SELECT * FROM events WHERE date >= ? AND date <= ? ORDER BY date, start").all(from, to)
    .filter(e => canSeeTeam(user, e.team_id));
  send(res, 200, list);
});

route("POST", /^\/events$/, false, async (req, res, user) => {
  const b = await readJson(req);
  const teamId = b.teamId ?? user.teamId;
  if (teamId == null || !b.date) return send(res, 400, { error: "팀·날짜가 없습니다" });
  if (!canSeeTeam(user, teamId)) return send(res, 403, { error: "권한 없음" });
  // 팀 공유 일정(개인 지정 없음)은 관리자만, 개인 일정은 본인 것만 (관리자는 팀원 것도)
  const memberEmail = b.memberEmail ? b.memberEmail.toLowerCase() : null;
  if (memberEmail == null && !user.isManager) return send(res, 403, { error: "팀 일정은 관리자만" });
  if (memberEmail != null && memberEmail !== user.email && !user.isManager)
    return send(res, 403, { error: "본인 일정만" });
  const r = db.prepare("INSERT INTO events (team_id, member_email, date, start, end, kind, title) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(teamId, memberEmail, b.date, b.start || null, b.end || null, b.kind || "기타", b.title || "");
  send(res, 200, { id: Number(r.lastInsertRowid) });
});

route("DELETE", /^\/events\/(\d+)$/, false, (req, res, user, m) => {
  const e = db.prepare("SELECT * FROM events WHERE id = ?").get(Number(m[1]));
  if (!e) return send(res, 404, { error: "없음" });
  const mine = e.member_email === user.email;
  if (!mine && !user.isManager) return send(res, 403, { error: "권한 없음" });
  if (!canSeeTeam(user, e.team_id)) return send(res, 403, { error: "권한 없음" });
  db.prepare("DELETE FROM events WHERE id = ?").run(e.id);
  send(res, 200, { ok: true });
});

// ---- 출근·Aitom (자가 보고) ----
route("GET", /^\/attendance$/, false, (req, res, user) => {
  const q = new URL(req.url, "http://x").searchParams;
  const date = q.get("date") || today();
  const emails = new Set(
    db.prepare("SELECT email, team_id FROM members").all()
      .filter(m => canSeeTeam(user, m.team_id)).map(m => m.email)
  );
  const list = db.prepare("SELECT * FROM attendance WHERE date = ?").all(date)
    .filter(a => emails.has(a.email));
  send(res, 200, list);
});

route("POST", /^\/attendance$/, false, async (req, res, user) => {
  const b = await readJson(req);
  db.prepare(
    `INSERT INTO attendance (email, date, present, reason, aitom) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(email, date) DO UPDATE SET present = excluded.present, reason = excluded.reason, aitom = excluded.aitom`
  ).run(user.email, b.date || today(), b.present ? 1 : 0, b.reason || "", b.aitom ? 1 : 0);
  send(res, 200, { ok: true });
});

// ---- 과제 ----
route("GET", /^\/tasks$/, false, (req, res, user) => {
  const list = db.prepare("SELECT * FROM tasks ORDER BY assigned DESC, id DESC").all()
    .filter(t => canSeeTeam(user, t.team_id))
    .map(t => ({ ...t, targets: JSON.parse(t.targets) }));
  send(res, 200, list);
});

route("POST", /^\/tasks$/, true, async (req, res, user) => {
  const b = await readJson(req);
  const teamId = b.teamId ?? user.teamId;
  if (teamId == null || !b.title) return send(res, 400, { error: "팀·제목이 없습니다" });
  if (!canSeeTeam(user, teamId)) return send(res, 403, { error: "권한 없음" });
  const r = db.prepare("INSERT INTO tasks (team_id, title, content, targets, status, assigned, due) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(teamId, b.title, b.content || "", JSON.stringify(b.targets || "전체"), "요청", today(), b.due || null);
  send(res, 200, { id: Number(r.lastInsertRowid) });
});

route("POST", /^\/tasks\/(\d+)\/status$/, false, async (req, res, user, m) => {
  const t = db.prepare("SELECT * FROM tasks WHERE id = ?").get(Number(m[1]));
  if (!t || !canSeeTeam(user, t.team_id)) return send(res, 403, { error: "권한 없음" });
  const b = await readJson(req);
  if (!["요청", "진행중", "완료"].includes(b.status)) return send(res, 400, { error: "상태 값 오류" });
  db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(b.status, t.id);
  send(res, 200, { ok: true });
});

// ---- 관리 (팀·구성원·설정) ----
route("POST", /^\/admin\/teams$/, true, async (req, res) => {
  const b = await readJson(req);
  if (!b.name) return send(res, 400, { error: "팀 이름이 없습니다" });
  const r = db.prepare("INSERT INTO teams (name) VALUES (?)").run(b.name);
  send(res, 200, { id: Number(r.lastInsertRowid) });
});

route("POST", /^\/admin\/members$/, true, async (req, res, user) => {
  const b = await readJson(req);
  if (!b.email) return send(res, 400, { error: "이메일이 없습니다" });
  // 관리자 임명(is_manager)·전체열람(can_view_all)은 총관리자만
  if ((b.isManager != null || b.canViewAll != null) && !user.isSuper)
    return send(res, 403, { error: "총관리자만" });
  db.prepare(
    `INSERT INTO members (email, name, team_id, role, is_manager, can_view_all) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       name = excluded.name, team_id = excluded.team_id, role = excluded.role,
       is_manager = COALESCE(?, members.is_manager),
       can_view_all = COALESCE(?, members.can_view_all)`
  ).run(
    b.email.toLowerCase(), b.name || "", b.teamId ?? null, b.role || "팀원",
    b.isManager ? 1 : 0, b.canViewAll ? 1 : 0,
    b.isManager == null ? null : (b.isManager ? 1 : 0),
    b.canViewAll == null ? null : (b.canViewAll ? 1 : 0)
  );
  send(res, 200, { ok: true });
});

route("DELETE", /^\/admin\/members\/([^/]+)$/, true, (req, res, user, m) => {
  db.prepare("DELETE FROM members WHERE email = ?").run(decodeURIComponent(m[1]).toLowerCase());
  send(res, 200, { ok: true });
});

route("POST", /^\/admin\/settings$/, true, async (req, res, user) => {
  if (!user.isSuper) return send(res, 403, { error: "총관리자만" });
  const b = await readJson(req);
  const { setSetting } = await import("./db.js");
  for (const [k, v] of Object.entries(b)) setSetting(db, k, String(v));
  send(res, 200, { ok: true });
});

// ---------- 서버 ----------

const server = createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const path = new URL(req.url, "http://x").pathname;
  if (path === "/health") return send(res, 200, { ok: true });

  const user = userFor(req);
  if (!user) return send(res, 401, { error: "로그인이 필요합니다" });

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.pattern.exec(path);
    if (!m) continue;
    if (r.needManager && !user.isManager) return send(res, 403, { error: "관리자만" });
    try { return await r.handler(req, res, user, m); }
    catch (e) { return send(res, 500, { error: "서버 오류" }); }
  }
  send(res, 404, { error: "없는 경로" });
});

server.listen(PORT, () => console.log("ourbranch API :" + PORT));
