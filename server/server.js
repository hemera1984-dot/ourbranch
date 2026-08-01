// 하랑지점(ourbranch) API 서버
//
// 원칙: 차단은 서버가 한다. 열람 범위(자기 팀 / 지점 전체)는 브라우저가 아니라
// 여기서 가른다. 인증은 마이가디언 세션 공유(auth.js) — 로그인 화면은 마이가디언
// 것을 쓰고, 이 서버는 토큰만 검증한다.
//
// 외부 패키지를 쓰지 않는다 (Node 22+ 내장 http·sqlite).

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { openDb, getSetting, getMember } from "./db.js";
import { openAuthDb, accountForToken } from "./auth.js";

const PORT = Number(process.env.PORT || 8788);
const DB_FILE = process.env.DB_FILE || "./ourbranch.db";
const AUTH_DB_FILE = process.env.AUTH_DB_FILE || "../myguardian-server/myguardian.db";
const ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
const WEB_DIR = process.env.WEB_DIR || "";   // 개발용: web/을 같은 출처로 서빙

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
  // 도입자: 팀이 달라도 자기가 도입한 팀원의 일정을 본다
  const recruits = db.prepare("SELECT email FROM members WHERE recruiter_email = ?").all(email).map(r => r.email);
  return {
    email,
    name: acc.name,
    grade: acc.grade,
    teamId: member ? member.team_id : null,
    isSuper,
    isManager: isSuper || gradeManager || !!(member && member.is_manager),
    seesAll: isSuper || acc.grade === "BM" || !!(member && member.can_view_all),
    recruits
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
  const members = db.prepare("SELECT email, name, team_id, role, is_manager, can_view_all, recruiter_email FROM members ORDER BY team_id, name").all()
    .filter(m => canSeeTeam(user, m.team_id) || user.recruits.includes(m.email));
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
      comments: db.prepare("SELECT * FROM comments WHERE notice_id = ? ORDER BY id").all(n.id),
      reads: db.prepare("SELECT email, name, created FROM notice_reads WHERE notice_id = ? ORDER BY created").all(n.id)
    }));
  send(res, 200, list);
});

// 확인 버튼 — 한 번 누르면 확인, 다시 누르면 취소
route("POST", /^\/notices\/(\d+)\/read$/, false, async (req, res, user, m) => {
  const n = db.prepare("SELECT * FROM notices WHERE id = ?").get(Number(m[1]));
  if (!n || !canSeeTeam(user, n.team_id)) return send(res, 403, { error: "권한 없음" });
  const has = db.prepare("SELECT 1 FROM notice_reads WHERE notice_id = ? AND email = ?").get(n.id, user.email);
  if (has) db.prepare("DELETE FROM notice_reads WHERE notice_id = ? AND email = ?").run(n.id, user.email);
  else db.prepare("INSERT INTO notice_reads (notice_id, email, name, created) VALUES (?, ?, ?, ?)")
    .run(n.id, user.email, user.name, now());
  send(res, 200, { read: !has });
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
    .filter(e => canSeeTeam(user, e.team_id) || (e.member_email && user.recruits.includes(e.member_email)));
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
  const r = db.prepare("INSERT INTO events (team_id, member_email, date, start, end, kind, title, place) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(teamId, memberEmail, b.date, b.start || null, b.end || null, b.kind || "기타", b.title || "", b.place || "");
  send(res, 200, { id: Number(r.lastInsertRowid) });
});

// 마이가디언 고객미팅 연동 — docs/myguardian-schedule-interop.md 계약 구현.
// 멱등키(출처키)로 upsert. 소유자 = 요청 세션 계정. 취소는 삭제가 아니라 상태 갱신.
route("POST", /^\/events\/upsert$/, false, async (req, res, user) => {
  const b = await readJson(req);
  if (b["출처"] !== "myguardian" || !b["출처키"] || !b["일시"])
    return send(res, 400, { error: "출처·출처키·일시가 필요합니다" });
  const iso = String(b["일시"]);
  const date = iso.slice(0, 10), start = iso.slice(11, 16) || null;
  const code = String(b["고객코드"] || "");
  const title = code + (b["차수"] ? " · " + b["차수"] + "차" : "");
  const status = ["예정", "완료", "취소"].includes(b["상태"]) ? b["상태"] : "예정";
  db.prepare(
    `INSERT INTO events (team_id, member_email, date, start, kind, title, source, source_key, status, customer_code)
     VALUES (?, ?, ?, ?, ?, ?, 'myguardian', ?, ?, ?)
     ON CONFLICT(source_key) DO UPDATE SET
       date = excluded.date, start = excluded.start, status = excluded.status,
       title = excluded.title, customer_code = excluded.customer_code`
  ).run(user.teamId, user.email, date, start, b["종류"] || "고객미팅", title, b["출처키"], status, code);
  send(res, 200, { ok: true });
});

route("POST", /^\/events\/(\d+)$/, false, async (req, res, user, m) => {
  const e = db.prepare("SELECT * FROM events WHERE id = ?").get(Number(m[1]));
  if (!e || !canSeeTeam(user, e.team_id)) return send(res, 403, { error: "권한 없음" });
  if (e.member_email !== user.email && !user.isManager) return send(res, 403, { error: "본인 일정만" });
  const b = await readJson(req);
  db.prepare("UPDATE events SET member_email = ?, date = ?, start = ?, end = ?, kind = ?, title = ?, place = ? WHERE id = ?")
    .run(b.memberEmail !== undefined ? (b.memberEmail ? b.memberEmail.toLowerCase() : null) : e.member_email,
         b.date ?? e.date, b.start ?? e.start, b.end ?? e.end, b.kind ?? e.kind, b.title ?? e.title, b.place ?? e.place, e.id);
  send(res, 200, { ok: true });
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
    .map(t => ({
      ...t, targets: JSON.parse(t.targets),
      dones: db.prepare("SELECT email, name, created FROM task_done WHERE task_id = ? ORDER BY created").all(t.id)
    }));
  send(res, 200, list);
});

// 달성 체크 — 대상 본인이 누른다. 다시 누르면 취소.
route("POST", /^\/tasks\/(\d+)\/done$/, false, async (req, res, user, m) => {
  const t = db.prepare("SELECT * FROM tasks WHERE id = ?").get(Number(m[1]));
  if (!t || !canSeeTeam(user, t.team_id)) return send(res, 403, { error: "권한 없음" });
  const targets = JSON.parse(t.targets);
  const isTarget = targets === "전체" || (Array.isArray(targets) && targets.includes(user.email));
  if (!isTarget) return send(res, 403, { error: "미션 대상만" });
  const has = db.prepare("SELECT 1 FROM task_done WHERE task_id = ? AND email = ?").get(t.id, user.email);
  if (has) db.prepare("DELETE FROM task_done WHERE task_id = ? AND email = ?").run(t.id, user.email);
  else db.prepare("INSERT INTO task_done (task_id, email, name, created) VALUES (?, ?, ?, ?)")
    .run(t.id, user.email, user.name, now());
  send(res, 200, { done: !has });
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
  // 상태 변경은 미션 대상 본인 또는 관리자만
  const targets = JSON.parse(t.targets);
  const isTarget = targets === "전체" || (Array.isArray(targets) && targets.includes(user.email));
  if (!isTarget && !user.isManager) return send(res, 403, { error: "대상 본인만" });
  const b = await readJson(req);
  if (!["요청", "진행중", "완료"].includes(b.status)) return send(res, 400, { error: "상태 값 오류" });
  db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(b.status, t.id);
  send(res, 200, { ok: true });
});

route("DELETE", /^\/tasks\/(\d+)$/, true, (req, res, user, m) => {
  const t = db.prepare("SELECT * FROM tasks WHERE id = ?").get(Number(m[1]));
  if (!t || !canSeeTeam(user, t.team_id)) return send(res, 403, { error: "권한 없음" });
  db.prepare("DELETE FROM tasks WHERE id = ?").run(t.id);
  send(res, 200, { ok: true });
});

route("DELETE", /^\/notices\/(\d+)$/, true, (req, res, user, m) => {
  const n = db.prepare("SELECT * FROM notices WHERE id = ?").get(Number(m[1]));
  if (!n || !canSeeTeam(user, n.team_id)) return send(res, 403, { error: "권한 없음" });
  db.prepare("DELETE FROM notices WHERE id = ?").run(n.id);
  send(res, 200, { ok: true });
});

// ---- TA 일지 ----
// 엑셀형 그리드 전제: 조회는 월 단위 한 방, 저장은 여러 줄 한 방(붙여넣기 대응).
const TA_FIELDS = ["date", "cand_name", "gender", "age", "region", "safe_phone", "real_phone", "result", "reject_sms", "cis_sms", "note"];

route("GET", /^\/ta$/, false, (req, res, user) => {
  const q = new URL(req.url, "http://x").searchParams;
  const month = q.get("month") || today().slice(0, 7);
  const list = db.prepare("SELECT * FROM ta_logs WHERE date LIKE ? ORDER BY date, id").all(month + "%")
    .filter(r => canSeeTeam(user, r.team_id));
  send(res, 200, list);
});

route("POST", /^\/ta$/, false, async (req, res, user) => {
  const b = await readJson(req);                          // { teamId?, rows: [...] }
  const teamId = b.teamId ?? user.teamId;
  if (teamId == null || !Array.isArray(b.rows)) return send(res, 400, { error: "팀·행이 없습니다" });
  if (!canSeeTeam(user, teamId)) return send(res, 403, { error: "권한 없음" });
  const ins = db.prepare(`INSERT INTO ta_logs (team_id, author, ${TA_FIELDS.join(", ")})
    VALUES (?, ?${", ?".repeat(TA_FIELDS.length)})`);
  const ids = [];
  for (const r of b.rows) {
    if (!r.date) continue;
    // 일지는 각 팀원이 본인 이름으로 넣는다. 남 이름으로 넣는 건 부지점장(관리자)만.
    const author = r.author || user.name;
    if (!user.isManager && author !== user.name) return send(res, 403, { error: "본인 일지만 입력할 수 있습니다" });
    ids.push(Number(ins.run(teamId, author, ...TA_FIELDS.map(f => String(r[f] ?? ""))).lastInsertRowid));
  }
  send(res, 200, { ids });
});

route("POST", /^\/ta\/(\d+)$/, false, async (req, res, user, m) => {
  const row = db.prepare("SELECT * FROM ta_logs WHERE id = ?").get(Number(m[1]));
  if (!row || !canSeeTeam(user, row.team_id)) return send(res, 403, { error: "권한 없음" });
  if (row.author !== user.name && !user.isManager) return send(res, 403, { error: "본인 기록만" });
  const b = await readJson(req);
  const sets = TA_FIELDS.filter(f => b[f] != null);
  if (b.author != null) sets.push("author");
  if (!sets.length) return send(res, 400, { error: "고칠 값이 없습니다" });
  db.prepare(`UPDATE ta_logs SET ${sets.map(f => f + " = ?").join(", ")} WHERE id = ?`)
    .run(...sets.map(f => String(b[f])), row.id);
  send(res, 200, { ok: true });
});

route("DELETE", /^\/ta\/(\d+)$/, false, (req, res, user, m) => {
  const row = db.prepare("SELECT * FROM ta_logs WHERE id = ?").get(Number(m[1]));
  if (!row || !canSeeTeam(user, row.team_id)) return send(res, 403, { error: "권한 없음" });
  if (row.author !== user.name && !user.isManager) return send(res, 403, { error: "본인 기록만" });
  db.prepare("DELETE FROM ta_logs WHERE id = ?").run(row.id);
  send(res, 200, { ok: true });
});

// ---- 업적현황 ----
route("GET", /^\/perf$/, false, (req, res, user) => {
  const q = new URL(req.url, "http://x").searchParams;
  const month = q.get("month") || today().slice(0, 7);
  const rows = db.prepare("SELECT * FROM perf WHERE month = ? ORDER BY member, contract_date, id").all(month)
    .filter(r => canSeeTeam(user, r.team_id));
  const goals = db.prepare("SELECT * FROM perf_goals WHERE month = ?").all(month)
    .filter(g => canSeeTeam(user, g.team_id));
  send(res, 200, { rows, goals });
});

route("POST", /^\/perf$/, false, async (req, res, user) => {
  const b = await readJson(req);                          // { teamId?, month, rows: [{member, contract_date, premium, canp, note}] }
  const teamId = b.teamId ?? user.teamId;
  if (teamId == null || !b.month || !Array.isArray(b.rows)) return send(res, 400, { error: "팀·월·행이 없습니다" });
  if (!canSeeTeam(user, teamId)) return send(res, 403, { error: "권한 없음" });
  const ins = db.prepare("INSERT INTO perf (team_id, month, member, contract_date, premium, canp, note) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const ids = [];
  for (const r of b.rows) {
    if (!r.member) continue;
    // 팀원은 자기 업적만, 부지점장(관리자)은 팀 전체 입력 가능
    if (!user.isManager && r.member !== user.name) return send(res, 403, { error: "본인 업적만 입력할 수 있습니다" });
    ids.push(Number(ins.run(teamId, b.month, r.member, r.contract_date || "", Number(r.premium) || 0, Number(r.canp) || 0, r.note || "").lastInsertRowid));
  }
  send(res, 200, { ids });
});

route("POST", /^\/perf\/(\d+)$/, false, async (req, res, user, m) => {
  const row = db.prepare("SELECT * FROM perf WHERE id = ?").get(Number(m[1]));
  if (!row || !canSeeTeam(user, row.team_id)) return send(res, 403, { error: "권한 없음" });
  if (row.member !== user.name && !user.isManager) return send(res, 403, { error: "본인 업적만" });
  const b = await readJson(req);
  db.prepare("UPDATE perf SET contract_date = ?, premium = ?, canp = ?, note = ? WHERE id = ?")
    .run(b.contract_date ?? row.contract_date, Number(b.premium ?? row.premium) || 0,
         Number(b.canp ?? row.canp) || 0, b.note ?? row.note, row.id);
  send(res, 200, { ok: true });
});

route("DELETE", /^\/perf\/(\d+)$/, false, (req, res, user, m) => {
  const row = db.prepare("SELECT * FROM perf WHERE id = ?").get(Number(m[1]));
  if (!row || !canSeeTeam(user, row.team_id)) return send(res, 403, { error: "권한 없음" });
  if (row.member !== user.name && !user.isManager) return send(res, 403, { error: "본인 업적만" });
  db.prepare("DELETE FROM perf WHERE id = ?").run(row.id);
  send(res, 200, { ok: true });
});

route("POST", /^\/perf\/goals$/, true, async (req, res, user) => {
  const b = await readJson(req);                          // { teamId?, month, goals: [{member, goal}] }
  const teamId = b.teamId ?? user.teamId;
  if (teamId == null || !b.month || !Array.isArray(b.goals)) return send(res, 400, { error: "팀·월·목표가 없습니다" });
  if (!canSeeTeam(user, teamId)) return send(res, 403, { error: "권한 없음" });
  const up = db.prepare(
    `INSERT INTO perf_goals (team_id, month, member, goal, intro) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(team_id, month, member) DO UPDATE SET goal = excluded.goal, intro = excluded.intro`
  );
  for (const g of b.goals) if (g.member) up.run(teamId, b.month, g.member, g.goal || "", Number(g.intro) || 0);
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
    `INSERT INTO members (email, name, team_id, role, is_manager, can_view_all, recruiter_email) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       name = excluded.name, team_id = excluded.team_id, role = excluded.role,
       is_manager = COALESCE(?, members.is_manager),
       can_view_all = COALESCE(?, members.can_view_all),
       recruiter_email = COALESCE(?, members.recruiter_email)`
  ).run(
    b.email.toLowerCase(), b.name || "", b.teamId ?? null, b.role || "팀원",
    b.isManager ? 1 : 0, b.canViewAll ? 1 : 0, b.recruiterEmail ? b.recruiterEmail.toLowerCase() : null,
    b.isManager == null ? null : (b.isManager ? 1 : 0),
    b.canViewAll == null ? null : (b.canViewAll ? 1 : 0),
    b.recruiterEmail === undefined ? null : (b.recruiterEmail ? b.recruiterEmail.toLowerCase() : "")
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

  // 개발용 정적 서빙 — API 경로와 겹치지 않는 GET만
  if (WEB_DIR && req.method === "GET") {
    const rel = path === "/" ? "index.html" : path.slice(1);
    const file = normalize(join(WEB_DIR, rel));
    if (file.startsWith(normalize(WEB_DIR)) && existsSync(file) && extname(file)) {
      const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
      res.writeHead(200, { "Content-Type": (types[extname(file)] || "application/octet-stream") + "; charset=utf-8" });
      return res.end(readFileSync(file));
    }
    if (path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(readFileSync(normalize(join(WEB_DIR, "index.html"))));
    }
  }

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
