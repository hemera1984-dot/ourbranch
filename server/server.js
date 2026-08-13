// 하랑지점(ourbranch) API 서버
//
// 원칙: 차단은 서버가 한다. 열람 범위(자기 팀 / 지점 전체)는 브라우저가 아니라
// 여기서 가른다. 인증은 마이가디언 세션 공유(auth.js) — 로그인 화면은 마이가디언
// 것을 쓰고, 이 서버는 토큰만 검증한다.
//
// 외부 패키지를 쓰지 않는다 (Node 22+ 내장 http·sqlite).

import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync, statSync, readdirSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { openDb, getSetting, setSetting, getMember } from "./db.js";
import { openAuthDb, accountForToken, listAccounts } from "./auth.js";
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.PORT || 8788);
const DB_FILE = process.env.DB_FILE || "./ourbranch.db";
const AUTH_DB_FILE = process.env.AUTH_DB_FILE || "../myguardian-server/myguardian.db";
const ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
const WEB_DIR = process.env.WEB_DIR || "";   // 개발용: web/을 같은 출처로 서빙
// 서류 파일이 실제로 놓이는 곳. 저장소에는 절대 들어가지 않는다(개인정보).
const FILE_DIR = process.env.FILE_DIR || "./files";
const MAX_FILE = 8 * 1024 * 1024;            // 합격증·수료증은 사진 한 장이면 충분하다

const db = openDb(DB_FILE);
const authDb = openAuthDb(AUTH_DB_FILE);

// 한국 시간 기준. toISOString()은 UTC라 오전 9시 이전 기록이 전날로 넘어가고
// 시각도 9시간 어긋난다 (08:40 출근 → "23:40 출근"으로 표시되던 문제).
const KST = 9 * 3600e3;
const now = () => new Date(Date.now() + KST).toISOString().replace("Z", "+09:00");
const today = () => new Date(Date.now() + KST).toISOString().slice(0, 10);

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
    req.on("data", c => {
      data += c;
      if (data.length > 1e6) { req.destroy(); reject(new Error("too large")); }   // 끊고 나서 대기하지 않는다
    });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error("bad json")); } });
    req.on("error", reject);
  });
}

// 날짜는 YYYY-MM-DD만 받는다. 다른 모양을 그대로 저장하면 월 조회에서 빠져
// "저장은 됐는데 화면에서 사라진" 것처럼 보인다 (조용한 데이터 유실).
// 모양만 맞고 달력에 없는 날(2026-99-99, 2월 30일)이 들어오면 월 조회에서 빠져
// 「저장은 됐는데 사라진」 것처럼 보인다. 실제 날짜인지까지 본다.
const isDate = v => {
  const t = String(v || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
  const [y, mo, d] = t.split("-").map(Number);
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
};

// 엑셀에서 붙여넣은 "1,000"·"1,000원"도 숫자로 받는다 (Number()는 NaN → 0이 되어 금액이 사라진다)
function num(v) {
  if (typeof v === "number") return isFinite(v) ? v : 0;
  const n = parseFloat(String(v == null ? "" : v).replace(/[^0-9.\-]/g, ""));
  return isFinite(n) ? n : 0;
}

// 여러 줄을 한 번에 저장할 때는 전부 되거나 전부 안 되거나여야 한다.
// 중간에 실패하면 앞줄만 저장된 채 오류가 나고, 사용자가 다시 누르면 중복된다.
function tx(fn) {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* 이미 풀렸으면 무시 */ }
    throw e;
  }
}

// ---------- 권한 ----------
//
// 사용자(user) = 마이가디언 계정 + ourbranch 소속 정보.
// - super: 마이가디언 총관리자 (is_admin)
// - manager: 관리자 — 팀원 추가·삭제, 조직도 수정. 부지점장 이상 기본, 총관리자가 토글.
// - 열람 범위: super·지점장(BM)·can_view_all → 지점 전체 / 그 외 → 자기 팀

// 조직도 직급명 → 코드. 직급 서열은 BM > ESL > SSL > GSL > FC (헌법 조직·권한 절).
const GRADE_OF_ROLE = {
  "지점장": "BM", "수석 부지점장": "ESL", "부지점장": "ESL",
  "팀장": "SSL", "부팀장": "GSL", "팀원": "FC"
};
// 권한 순서 — 총관리자(isSuper) > 지점장 > 수석 부지점장 > 부지점장 > 팀장 > 부팀장 > 팀원.
// 마이가디언 등급(GRADE)은 다섯 칸뿐이라 수석·부지점장을 가르지 못한다. 여기서 가른다.
const ROLE_ORDER = ["지점장", "수석 부지점장", "부지점장", "팀장", "부팀장", "팀원"];
const ROLE_OF_GRADE = { BM: "지점장", ESL: "부지점장", SSL: "팀장", GSL: "부팀장", FC: "팀원" };
const roleRank = r => { const i = ROLE_ORDER.indexOf(r); return i < 0 ? 99 : i; };
const GRADE_RANK = ["BM", "ESL", "SSL", "GSL", "FC"];
const rankOf = g => { const i = GRADE_RANK.indexOf(g); return i < 0 ? 99 : i; };
const topGrade = (a, b) => (rankOf(a) <= rankOf(b) ? a : b) || null;

function userFor(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  const acc = accountForToken(authDb, m ? m[1] : null);
  if (!acc) return null;
  const email = acc.email.toLowerCase();
  const member = getMember(db, email);
  // 마이가디언에서 아직 승인 전인 계정에는 그쪽 직급·총관리자 권한을 적용하지 않는다.
  // 하랑지점 접근 여부는 아래 명단(members)으로만 가른다.
  const mgApproved = acc.status === "승인";
  const isSuper = mgApproved && !!acc.is_admin;
  // 총관리자를 뺀 나머지는 이 지점 명단(members)에 있어야 한다.
  // 명단에 없으면 가입 신청 경로만 열린다(승인 대기).
  if (!member && !isSuper) return { email, name: acc.name, unlisted: true };
  // 명단에서 내린 사람은 로그인해도 자료를 볼 수 없다 (기록은 남기되 접근은 끊는다)
  if (member && member.active === 0 && !isSuper) return { email, name: member.name, unlisted: true };
  // 직급은 하랑지점 조직도(role)가 기준이다. 마이가디언 직급은 조직도 직급이 없거나
  // 더 높을 때만 쓴다 — 조직도에 부지점장으로 올려놨는데 마이가디언 승인이 늦어서
  // 관리자 권한이 없는 일이 없게. 부지점장·지점장은 관리자급이다(2026-08-02 확인).
  const grade = topGrade(member && GRADE_OF_ROLE[member.role], mgApproved ? acc.grade : null);
  const gradeManager = grade === "BM" || grade === "ESL";
  // 도입자: 팀이 달라도 자기가 도입한 팀원의 일정을 본다
  const recruits = db.prepare("SELECT email FROM members WHERE recruiter_email = ? AND active <> 0")
    .all(email).map(r => r.email);
  return {
    email,
    name: (member && member.name) || acc.name,
    grade,
    teamId: member ? member.team_id : null,
    role: (member && member.role) || ROLE_OF_GRADE[mgApproved ? acc.grade : null] || null,
    isSuper,
    isManager: isSuper || gradeManager || !!(member && member.is_manager),
    seesAll: isSuper || grade === "BM" || !!(member && member.can_view_all),
    recruits
  };
}

// 관리자가 손댈 수 있는 대상인지 — 열람이 아니라 쓰기 기준이다.
// (전체열람 부지점장이 남의 팀 구성원을 옮기거나 지우지 못하게)
function canManageMember(user, targetEmail) {
  if (user.isSuper) return true;
  const t = getMember(db, targetEmail);
  if (!t) return user.teamId != null;                  // 신규 등록은 자기 팀으로 들어간다
  return canWriteTeam(user, t.team_id);
}

// 일정 열람 — 주인이 있는 일정에는 canSeeTeam을 그대로 쓰지 않는다.
// canSeeTeam(_, null)은 「대상 없는 지점 공통」이라 전원 통과인데, 팀이 없는 사람의
// 개인 일정까지 그 길로 새어 나갔다 (코덱스 검증 2026-08-05).
function canSeeEvent(user, e) {
  if (e.kind === "강의") return true;                           // 강의는 지점 전체 대상이다
  if (!e.member_email) return canSeeTeam(user, e.team_id);      // 대상 없는 팀·지점 일정
  if (e.member_email === user.email) return true;
  if (user.recruits.includes(e.member_email)) return true;      // 내가 도입한 사람
  const t = teamOfOwner(e.member_email);                        // 지금 그 사람의 팀
  if (t == null) return user.isSuper || user.grade === "BM";    // 팀이 없으면 지점장 이상만
  return canSeeTeam(user, t);
}

// 열람 가능한 team_id (지점 공통 = NULL은 전원 열람)
function canSeeTeam(user, teamId) {
  if (teamId == null) return true;
  return user.seesAll || user.teamId === teamId;
}

// 쓰기 가능한 team_id — 열람과 분리한다.
// 총관리자·지점장(BM)은 지점 전체에 쓴다. 부지점장은 자기 팀만.
// can_view_all(전체열람)은 "보는" 권한이지 "쓰는" 권한이 아니다.
// 지점 공통(NULL) 자원은 총관리자·지점장만 건드린다.
function isBranchHead(user) {
  return user.isSuper || user.grade === "BM";
}
function canWriteTeam(user, teamId) {
  if (isBranchHead(user)) return true;
  if (teamId == null) return false;
  return user.teamId === teamId;
}

// 기록의 주인인지 — 이름이 아니라 이메일로 본다.
// 이름으로 보면 동명이인이 서로의 기록을 수정하고, 개명하면 과거 기록을 잃는다.
// 이메일이 비어 있는 옛 기록만 이름으로 대조한다(이관 전 데이터).
function isOwner(user, ownerEmail, ownerName) {
  if (ownerEmail) return ownerEmail === user.email;
  return ownerName === user.name;
}

// 이름 → 이메일. 동명이인이면 누구인지 특정할 수 없으므로 null.
function emailForName(name) {
  const rows = db.prepare("SELECT email FROM members WHERE name = ?").all(name);
  return rows.length === 1 ? rows[0].email : null;
}

// 목표를 정하는 사람 — 부지점장 이상. 팀장·부팀장이 관리자로 임명돼 있어도
// 목표는 못 건드린다. 목표는 팀을 맡은 사람이 거는 것이라서다 (2026-08-05 사용자).
function canSetGoal(user) {
  return user.isSuper || user.grade === "BM" || user.grade === "ESL";
}

// 남에게 줄 수 있는 직급인가 — 직급이 곧 권한이라 자기보다 높은 자리는 못 만든다.
// 직급이 들어오는 모든 길(추가·수정·승인·초대)이 이 하나를 지난다.
function canAssignRole(user, role) {
  if (!role) return true;                                   // 안 바꾸는 요청
  if (!ROLE_ORDER.includes(role)) return false;             // 목록에 없는 직급은 받지 않는다
  if (user.isSuper) return true;
  // 내 직급이 목록 밖이거나 비어 있으면 마이가디언 등급으로 자리를 잡는다.
  // 그냥 99로 두면 팀원조차 못 주는 과잉 차단이 된다(코덱스 검증 2026-08-05).
  const mine = ROLE_ORDER.includes(user.role) ? user.role : ROLE_OF_GRADE[user.grade];
  return roleRank(role) >= roleRank(mine);
}

// 승인권자 — 지점장·부지점장·총관리자 (2026-08-01 확정)
function canApprove(user) {
  return user.isSuper || user.grade === "BM" || user.grade === "ESL" || user.isManager;
}

// ---------- TA 일지 잠금·보관기간 ----------
//
// TA 일지에는 후보자 실명·전화번호가 들어간다. 지점 전체가 함께 보는 이유는
// 「같은 사람에게 두 번 연락해서 민원이 나는 것」을 막기 위해서다. 그래서 열되,
// 지점 공용 비밀번호로 한 겹 잠그고, 누가 열었는지 남기고, 6개월이 지나면 지운다.

const TA_UNLOCK_HOURS = 8;          // 하루 업무 단위. 매번 묻지 않되 다음 날은 다시 묻는다.
const TA_KEEP_MONTHS = 6;           // 보관기간 (2026-08-02 사용자 확정)

function hashPw(pw, salt) {
  return scryptSync(String(pw), salt, 64).toString("hex");
}
function setTaPassword(pw) {
  const salt = randomBytes(16).toString("hex");
  setSetting(db, "ta_pw", salt + "$" + hashPw(pw, salt));
}
function taLockEnabled() {
  return !!getSetting(db, "ta_pw");
}
function checkTaPassword(pw) {
  const stored = getSetting(db, "ta_pw");
  if (!stored) return false;
  const [salt, hash] = stored.split("$");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(hashPw(pw, salt), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
function taUnlocked(user) {
  if (!taLockEnabled()) return true;
  const row = db.prepare("SELECT until FROM ta_unlock WHERE email = ?").get(user.email);
  return !!row && row.until > now();
}
function unlockTa(user) {
  const until = new Date(Date.now() + KST + TA_UNLOCK_HOURS * 3600e3).toISOString().replace("Z", "+09:00");
  db.prepare("INSERT INTO ta_unlock (email, until) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET until = excluded.until")
    .run(user.email, until);
  db.prepare("INSERT INTO ta_access (email, name, created) VALUES (?, ?, ?)").run(user.email, user.name, now());
  return until;
}

// 6개월 지난 일지는 지운다. 켜질 때 한 번, 이후 하루 한 번.
// (백업은 backup.sh가 14일 보관하므로 사고가 나도 되돌릴 여지가 있다)
function purgeOldTa() {
  const d = new Date(Date.now() + KST);
  d.setMonth(d.getMonth() - TA_KEEP_MONTHS);
  const cutoff = d.toISOString().slice(0, 10);
  const n = db.prepare("SELECT COUNT(*) n FROM ta_logs WHERE date < ?").get(cutoff).n;
  if (n) {
    db.prepare("DELETE FROM ta_logs WHERE date < ?").run(cutoff);
    console.log("[TA 보관기간] " + cutoff + " 이전 " + n + "건 삭제");
  }
  // 열람 기록도 같은 기간만 남긴다
  db.prepare("DELETE FROM ta_access WHERE created < ?").run(cutoff);
}

// 주인 없는 파일 청소 — 서류 파일에는 실명·생년월일이 들어 있다.
// 업로드 도중 프로세스가 죽거나 DB만 되돌아가면 파일만 디스크에 남는다.
// DB에 없는 파일은 지운다. 단, **막 올라온 것은 건드리지 않는다** —
// INSERT 직전의 파일을 청소가 먼저 지워 버리면 방금 올린 서류가 사라진다.
const ORPHAN_GRACE = 60 * 60e3;          // 한 시간

// 이 폴더가 이 DB의 것인지 표식으로 확인한다. FILE_DIR을 다른 DB의 폴더로
// 잘못 가리킨 채 켜면, 남의 서류를 「주인 없는 파일」로 보고 통째로 지운다
// (코덱스 검증 2026-08-05).
const FILE_MARK = ".ourbranch-files";

function purgeOrphanFiles() {
  if (!existsSync(FILE_DIR)) return;
  const mark = join(FILE_DIR, FILE_MARK);
  const mine = normalize(DB_FILE);
  if (!existsSync(mark)) writeFileSync(mark, mine);
  else if (readFileSync(mark, "utf8").trim() !== mine) {
    console.warn("[서류 청소] 이 폴더는 다른 DB의 것이다 — 청소를 하지 않는다: " + FILE_DIR);
    return;
  }
  const known = new Set(db.prepare("SELECT path FROM docs").all().map(r => r.path));
  known.add(FILE_MARK);
  const cutoff = Date.now() - ORPHAN_GRACE;
  let n = 0;
  for (const f of readdirSync(FILE_DIR)) {
    if (known.has(f)) continue;
    const full = join(FILE_DIR, f);
    try {
      if (statSync(full).mtimeMs > cutoff) continue;      // 아직 기록될 수 있다
      unlinkSync(full);
      n += 1;
    } catch { /* 다음 차례에 다시 본다 */ }
  }
  if (n) console.log("[서류 청소] 주인 없는 파일 " + n + "개 삭제");
}

// ---------- 라우팅 ----------

const routes = [];
function route(method, pattern, needManager, handler) {
  routes.push({ method, pattern, needManager, handler });
}

// 앱 셸 부트스트랩 — 지점명·팀·구성원·내 권한을 한 번에
route("GET", /^\/bootstrap$/, false, (req, res, user) => {
  // 조직도는 지점 전체가 다 보인다 (2026-08-02 사용자 지시) — 팀·구성원 명단은 가리지 않는다.
  // 가리는 것은 자료(일정·업적·TA·공지)이고, 그건 각 엔드포인트가 팀 단위로 막는다.
  const teams = db.prepare("SELECT * FROM teams ORDER BY id").all();
  const members = db.prepare("SELECT email, name, team_id, role, is_manager, can_view_all, recruiter_email, profile_done, phone, birthday, joined_at, sort_order, active, left_at FROM members ORDER BY team_id, name").all();
  send(res, 200, {
    branchName: getSetting(db, "지점명") || "",
    me: { ...user, canApprove: canApprove(user), isBranchHead: isBranchHead(user), canSetGoal: canSetGoal(user) },
    teams,
    members,
    pending: canApprove(user)
      ? db.prepare("SELECT * FROM pending ORDER BY created").all()
          .filter(p => user.seesAll || p.team_id == null || p.team_id === user.teamId)
      : []
  });
});

// ---------- 서류함 ----------
//
// 합격증·수료증에는 실명과 생년월일이 찍혀 있다. 그래서 열람을 좁게 연다:
// 본인 / 자기 팀 관리자 / 지점장·총관리자. 지점 공용 서류(사업자등록증)만 전원 열람.
//
// 업로드는 multipart를 쓰지 않는다 — 파서를 직접 짜야 하고 틀리기 쉽다.
// 메타는 쿼리로 받고 본문은 파일 그대로다.

const DOC_EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
                  "image/heic": ".heic", "application/pdf": ".pdf" };
const DOC_QUOTA = 30 * 1024 * 1024;          // 한 사람이 쌓을 수 있는 총량 (2026-08-05 사용자: 30MB면 충분)

// 헤더는 보내는 쪽이 마음대로 쓴다. 내용이 실제로 그 형식인지 앞머리로 확인한다.
function looksLike(mime, buf) {
  const b = buf;
  if (b.length < 12) return false;
  const at = (i, ...bytes) => bytes.every((v, k) => b[i + k] === v);
  switch (mime) {
    case "application/pdf": return at(0, 0x25, 0x50, 0x44, 0x46);                    // %PDF
    case "image/jpeg": return at(0, 0xff, 0xd8, 0xff);
    case "image/png": return at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/webp": return at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50);
    // ftyp만 보면 mp4도 통과한다 — 브랜드까지 확인한다
    case "image/heic": return b.slice(4, 8).toString("latin1") === "ftyp"
      && /^(heic|heix|hevc|hevx|mif1|msf1)/.test(b.slice(8, 12).toString("latin1"));
    default: return false;
  }
}

// 볼 수 있는 사람: 본인 / 직도입자 / 그 팀 부지점장 / 지점장·총관리자
// (2026-08-05 사용자 확정). 관리자로 임명된 팀장·부팀장에게는 열지 않는다 —
// 합격증에는 실명과 생년월일이 있어서 「관리자」보다 좁게 잡는다.
function ownerSide(user, email) {
  if (!email) return false;
  if (email === user.email) return true;
  return user.recruits.includes(email);           // 직도입자
}
// 지금 그 사람이 속한 팀. 기록에 박힌 team_id는 만들 때의 스냅숏이라,
// 팀을 옮기면 옛 팀 부지점장이 계속 열람하게 된다 (코덱스 검증 2026-08-05).
// 지금 그 사람이 속한 팀. 못 찾으면 undefined를 돌려준다 —
// 기록에 박힌 team_id(스냅숏)로 되돌아가면 옛 팀 부지점장이 계속 열람한다.
// 명단에서 내려간 사람(active=0)의 자료도 지점장·총관리자만 다룬다
// (코덱스 검증 2026-08-05).
function teamOfOwner(email) {
  const m = email ? getMember(db, email) : null;
  if (!m || m.active === 0) return undefined;
  return m.team_id;
}
// 개인 자료에는 canSeeTeam을 쓰지 않는다 — 그건 team_id가 null이면 전원 통과다
// (지점 공통 공지용). 팀 없는 사람의 합격증이 전 부지점장에게 열리면 안 된다.
function sameTeamLead(user, teamId) {
  if (user.isSuper || user.grade === "BM") return true;     // 지점장·총관리자는 지점 전체
  if (!canSetGoal(user)) return false;                      // 부지점장 미만은 남의 자료를 못 본다
  if (teamId == null) return false;                         // 주인이 명단에 없거나 팀이 없다
  // 전체열람(can_view_all)은 여기서 통하지 않는다 — 서류는 「그 팀 부지점장」까지다
  // (2026-08-05 사용자 지시). 대신 화면이 남의 팀 선택칸을 아예 안 준다.
  return user.teamId === teamId;
}
function canSeeDoc(user, d) {
  if (d.scope === "branch") return true;                    // 사업자등록증 등 지점 공용
  if (ownerSide(user, d.owner_email)) return true;
  return sameTeamLead(user, teamOfOwner(d.owner_email));
}
// 올리기·지우기 — 본인, 또는 그 팀 부지점장·지점장. 직도입자는 보기만 한다.
function canWriteDoc(user, d) {
  if (d.scope === "branch") return canSetGoal(user);
  if (d.owner_email && d.owner_email === user.email) return true;
  return sameTeamLead(user, teamOfOwner(d.owner_email));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", c => {
      n += c.length;
      if (n > limit) { req.destroy(); reject(new Error("too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

route("GET", /^\/docs$/, false, (req, res, user) => {
  const list = db.prepare("SELECT * FROM docs ORDER BY created DESC, id DESC").all()
    .filter(d => canSeeDoc(user, d))
    // 서버 경로와 업로더 이메일은 화면이 쓰지 않는다 — 필요한 것만 내보낸다
    .map(d => ({ id: d.id, scope: d.scope, owner_email: d.owner_email, team_id: d.team_id,
                 kind: d.kind, name: d.name, mime: d.mime, size: d.size, created: d.created }));
  send(res, 200, list);
});

route("POST", /^\/docs$/, false, async (req, res, user) => {
  const q = new URL(req.url, "http://x").searchParams;
  const scope = q.get("scope") === "branch" ? "branch" : "member";
  const owner = scope === "branch" ? null : String(q.get("email") || user.email).toLowerCase();
  const target = owner ? getMember(db, owner) : null;
  if (scope === "member" && !target) return send(res, 404, { error: "명단에 없는 사람입니다" });
  const draft = { scope, owner_email: owner, team_id: target ? target.team_id : null };
  if (!canWriteDoc(user, draft)) return send(res, 403, { error: "권한 없음" });

  const mime = String(req.headers["content-type"] || "").split(";")[0].trim();
  const ext = DOC_EXT[mime];
  if (!ext) return send(res, 400, { error: "PDF 또는 사진(JPG·PNG·HEIC)만 올릴 수 있습니다" });
  const name = String(q.get("name") || "").slice(0, 120) || ("서류" + ext);
  const kind = String(q.get("kind") || "").slice(0, 40);

  let buf;
  try { buf = await readBody(req, MAX_FILE); }
  catch { return send(res, 413, { error: "파일이 8MB를 넘습니다" }); }
  if (!buf.length) return send(res, 400, { error: "빈 파일입니다" });
  if (!looksLike(mime, buf))
    return send(res, 400, { error: "내용이 그 형식이 아닙니다. 원본 파일을 그대로 올려 주세요" });

  // 디스크가 넉넉하지 않다 — 한 사람이 쌓을 수 있는 양을 묶어 둔다
  const used = db.prepare(
    owner ? "SELECT COALESCE(SUM(size),0) n FROM docs WHERE owner_email = ?"
          : "SELECT COALESCE(SUM(size),0) n FROM docs WHERE scope = 'branch'"
  ).get(...(owner ? [owner] : [])).n;
  if (used + buf.length > DOC_QUOTA)
    return send(res, 413, { error: "보관 용량(1인 30MB)을 넘습니다. 오래된 서류를 지워 주세요" });

  // 파일 이름은 서버가 짓는다 — 올린 이름을 그대로 쓰면 경로를 벗어나는 이름이 섞인다
  const rel = randomBytes(12).toString("hex") + ext;
  mkdirSync(FILE_DIR, { recursive: true });
  writeFileSync(join(FILE_DIR, rel), buf);
  try {
    const r = db.prepare(
      `INSERT INTO docs (scope, owner_email, team_id, kind, name, mime, size, path, uploader, created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(scope, owner, draft.team_id, kind, name, mime, buf.length, rel, user.email, now());
    send(res, 200, { id: Number(r.lastInsertRowid) });
  } catch (e) {
    // 기록에 못 남겼으면 파일도 남기지 않는다 — 주인 없는 개인정보가 디스크에 뒹군다
    try { unlinkSync(join(FILE_DIR, rel)); } catch { /* 이미 없으면 그만 */ }
    throw e;
  }
});

route("GET", /^\/docs\/(\d+)\/file$/, false, (req, res, user, m) => {
  const d = db.prepare("SELECT * FROM docs WHERE id = ?").get(Number(m[1]));
  if (!d || !canSeeDoc(user, d)) return send(res, 403, { error: "권한 없음" });
  const file = normalize(join(FILE_DIR, d.path));
  if (!file.startsWith(normalize(FILE_DIR)) || !existsSync(file))
    return send(res, 404, { error: "파일이 없습니다" });
  res.writeHead(200, {
    "Content-Type": d.mime || "application/octet-stream",
    "Content-Length": statSync(file).size,
    // 이름에 한글이 들어가므로 filename* 로 보낸다
    "Content-Disposition": "inline; filename*=UTF-8''" + encodeURIComponent(d.name),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store"
  });
  res.end(readFileSync(file));
});

route("DELETE", /^\/docs\/(\d+)$/, false, (req, res, user, m) => {
  const d = db.prepare("SELECT * FROM docs WHERE id = ?").get(Number(m[1]));
  if (!d || !canWriteDoc(user, d)) return send(res, 403, { error: "권한 없음" });
  try { unlinkSync(join(FILE_DIR, d.path)); }
  catch (e) {
    // 파일이 원래 없으면 그냥 진행. 그 밖의 실패는 기록을 남겨 다시 지울 수 있게 한다
    if (e && e.code !== "ENOENT") return send(res, 500, { error: "파일을 지우지 못했습니다" });
  }
  db.prepare("DELETE FROM docs WHERE id = ?").run(d.id);
  send(res, 200, { ok: true });
});

// ---------- 교육 이수 현황 ----------
//
// 수료증 파일이 아직 없어도 「언제 무엇을 이수했는지」는 남겨야 한다.
// 보는 범위는 서류함과 같고, 쓰기는 본인과 그 팀 부지점장·지점장이다.

route("GET", /^\/trainings$/, false, (req, res, user) => {
  const list = db.prepare("SELECT * FROM trainings ORDER BY done_on DESC, id DESC").all()
    .filter(t => canSeeDoc(user, { scope: "member", owner_email: t.member_email, team_id: t.team_id }));
  send(res, 200, list);
});

route("POST", /^\/trainings$/, false, async (req, res, user) => {
  const b = await readJson(req);
  const email = String(b.email || user.email).toLowerCase();
  const target = getMember(db, email);
  if (!target) return send(res, 404, { error: "명단에 없는 사람입니다" });
  if (!canWriteDoc(user, { scope: "member", owner_email: email, team_id: target.team_id }))
    return send(res, 403, { error: "권한 없음" });
  const name = String(b.name || "").trim().slice(0, 60);
  if (!name) return send(res, 400, { error: "교육 이름이 없습니다" });
  let on = String(b.doneOn || "").trim();
  if (on) {
    if (/^\d{4}-\d{2}$/.test(on)) on += "-01";
    if (!isDate(on)) return send(res, 400, { error: "이수일은 2026-08-05 형식으로 넣어 주세요" });
  }
  const r = db.prepare(
    `INSERT INTO trainings (member_email, team_id, name, done_on, note, created) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(email, target.team_id, name, on, String(b.note || "").slice(0, 120), now());
  send(res, 200, { id: Number(r.lastInsertRowid) });
});

route("POST", /^\/trainings\/(\d+)$/, false, async (req, res, user, m) => {
  const t = db.prepare("SELECT * FROM trainings WHERE id = ?").get(Number(m[1]));
  if (!t) return send(res, 404, { error: "없는 기록입니다" });
  if (!canWriteDoc(user, { scope: "member", owner_email: t.member_email, team_id: t.team_id }))
    return send(res, 403, { error: "권한 없음" });
  const b = await readJson(req);
  const name = b.name !== undefined ? String(b.name).trim().slice(0, 60) : t.name;
  if (!name) return send(res, 400, { error: "교육 이름이 없습니다" });
  let on = b.doneOn !== undefined ? String(b.doneOn).trim() : t.done_on;
  if (on) {
    if (/^\d{4}-\d{2}$/.test(on)) on += "-01";
    if (!isDate(on)) return send(res, 400, { error: "이수일은 2026-08-05 형식으로 넣어 주세요" });
  }
  db.prepare("UPDATE trainings SET name = ?, done_on = ? WHERE id = ?").run(name, on, t.id);
  send(res, 200, { ok: true });
});

route("DELETE", /^\/trainings\/(\d+)$/, false, (req, res, user, m) => {
  const t = db.prepare("SELECT * FROM trainings WHERE id = ?").get(Number(m[1]));
  if (!t) return send(res, 404, { error: "없는 기록입니다" });
  if (!canWriteDoc(user, { scope: "member", owner_email: t.member_email, team_id: t.team_id }))
    return send(res, 403, { error: "권한 없음" });
  db.prepare("DELETE FROM trainings WHERE id = ?").run(t.id);
  send(res, 200, { ok: true });
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
  if (!canWriteTeam(user, teamId)) return send(res, 403, { error: "권한 없음" });
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
    .filter(e => canSeeEvent(user, e))
    .map(e => e.kind === "강의"
      ? { ...e, attendees: db.prepare("SELECT email, name FROM event_attendees WHERE event_id = ? ORDER BY created").all(e.id) }
      : e);
  send(res, 200, list);
});

// 강의 신청 — 팀이 달라도 지점 전체 강의에 신청할 수 있다. 다시 누르면 취소.
route("POST", /^\/events\/(\d+)\/attend$/, false, async (req, res, user, m) => {
  const e = db.prepare("SELECT * FROM events WHERE id = ?").get(Number(m[1]));
  if (!e || e.kind !== "강의") return send(res, 404, { error: "강의가 아닙니다" });
  if (!canSeeTeam(user, e.team_id)) return send(res, 403, { error: "권한 없음" });
  const has = db.prepare("SELECT 1 FROM event_attendees WHERE event_id = ? AND email = ?").get(e.id, user.email);
  if (has) db.prepare("DELETE FROM event_attendees WHERE event_id = ? AND email = ?").run(e.id, user.email);
  else db.prepare("INSERT INTO event_attendees (event_id, email, name, created) VALUES (?, ?, ?, ?)")
    .run(e.id, user.email, user.name, now());
  send(res, 200, { attending: !has });
});

route("POST", /^\/events$/, false, async (req, res, user) => {
  const b = await readJson(req);
  // 강의는 지점 전체 일정(team_id NULL) — 등록자 누구나, 강사 = 본인
  const teamId = b.kind === "강의" ? null : (b.teamId ?? user.teamId);
  if ((teamId == null && b.kind !== "강의") || !b.date) return send(res, 400, { error: "팀·날짜가 없습니다" });
  if (!isDate(b.date)) return send(res, 400, { error: "날짜 형식이 올바르지 않습니다: " + b.date });
  if (!canWriteTeam(user, teamId) && !(b.kind === "강의" && teamId == null)) return send(res, 403, { error: "권한 없음" });
  // 팀 공유 일정(개인 지정 없음)은 관리자만, 개인 일정은 본인 것만 (관리자는 팀원 것도)
  const memberEmail = b.memberEmail ? b.memberEmail.toLowerCase() : null;
  if (memberEmail == null && !canSetGoal(user)) return send(res, 403, { error: "팀 일정은 부지점장 이상만" });
  if (memberEmail != null && memberEmail !== user.email && !canSetGoal(user))
    return send(res, 403, { error: "본인 일정만" });
  // 대상은 지금 명단에 있는 사람이어야 하고, 그 사람의 팀으로 들어가야 한다.
  // 안 보면 남의 팀 사람 명의로 우리 팀에 일정을 심을 수 있다 (코덱스 검증 2026-08-05).
  if (memberEmail != null && memberEmail !== user.email) {
    const tm = getMember(db, memberEmail);
    if (!tm || tm.active === 0) return send(res, 404, { error: "명단에 없는 사람입니다" });
    if (tm.team_id !== teamId) return send(res, 400, { error: "그 팀 사람이 아닙니다" });
    if (!canWriteTeam(user, tm.team_id)) return send(res, 403, { error: "권한 없는 팀입니다" });
  }
  // 반복 — 규칙을 저장하지 않고 그 자리에서 날짜를 펼쳐 넣는다.
  // 수정·삭제가 한 건 단위로 단순해지고, 조회에 규칙 해석이 끼지 않는다.
  const rep = b.repeat || {};
  const stepDays = { day: 1, week: 7, "2week": 14 }[rep.every] || 0;
  const byMonth = rep.every === "month";            // 매월 같은 날짜 (교육·정기 회의)
  // 소수를 주면 루프가 한 번 더 돌아 13건이 된다 — 정수로 못박는다
  const count = stepDays || byMonth
    ? Math.min(Math.max(Math.floor(Number(rep.count)) || 1, 1), 52) : 1;

  const ins = db.prepare("INSERT INTO events (team_id, member_email, date, start, end, kind, title, place, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const detail = b.detail ? JSON.stringify(b.detail).slice(0, 2000) : "";
  const base = new Date(b.date + "T00:00:00");
  const ids = [];
  // 반복은 통째로 되거나 통째로 안 된다 — 중간에 멈추면 앞부분만 남고,
  // 다시 누르면 그만큼 겹친다 (코덱스 검증 2026-08-05).
  tx(() => {
  for (let i = 0; i < count; i++) {
    const d = byMonth
      // 31일에 매월을 걸면 2월은 3월로 넘어간다 — 말일로 당겨 그 달에 남긴다
      ? new Date(base.getFullYear(), base.getMonth() + i,
          Math.min(base.getDate(), new Date(base.getFullYear(), base.getMonth() + i + 1, 0).getDate()))
      : new Date(base.getFullYear(), base.getMonth(), base.getDate() + stepDays * i);
    const ds = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    ids.push(Number(ins.run(teamId, memberEmail, ds, b.start || null, b.end || null,
      b.kind || "기타", b.title || "", b.place || "", detail).lastInsertRowid));
  }
  });
  send(res, 200, { id: ids[0], ids, count: ids.length });
});

// 마이가디언 고객미팅 연동 — docs/myguardian-schedule-interop.md 계약 구현.
// 멱등키(출처키)로 upsert. 소유자 = 요청 세션 계정. 취소는 삭제가 아니라 상태 갱신.
route("POST", /^\/events\/upsert$/, false, async (req, res, user) => {
  const b = await readJson(req);
  if (b["출처"] !== "myguardian" || !b["출처키"] || !b["일시"])
    return send(res, 400, { error: "출처·출처키·일시가 필요합니다" });
  const iso = String(b["일시"]);
  const date = iso.slice(0, 10), start = iso.slice(11, 16) || null;
  // 이 경로만 날짜 검증이 빠져 있었다 — 이상한 값이 들어가면 달력에서 조용히 사라진다
  if (!isDate(date)) return send(res, 400, { error: "일시가 올바르지 않습니다: " + iso });
  const code = String(b["고객코드"] || "");
  const title = code + (b["차수"] ? " · " + b["차수"] + "차" : "");
  const status = ["예정", "완료", "취소"].includes(b["상태"]) ? b["상태"] : "예정";
  // 멱등키는 반드시 계정별로 분리한다. 전역 유니크면 같은 고객코드를 쓰는 다른 FC의
  // 일정을 덮어쓴다 (마이가디언 고객코드는 FC마다 독립 채번).
  const key = user.email + "|" + b["출처키"];
  db.prepare(
    `INSERT INTO events (team_id, member_email, date, start, kind, title, source, source_key, status, customer_code)
     VALUES (?, ?, ?, ?, ?, ?, 'myguardian', ?, ?, ?)
     ON CONFLICT(source_key) DO UPDATE SET
       team_id = excluded.team_id, date = excluded.date, start = excluded.start, status = excluded.status,
       title = excluded.title, customer_code = excluded.customer_code`
  ).run(user.teamId, user.email, date, start, b["종류"] || "고객미팅", title, key, status, code);
  send(res, 200, { ok: true });
});

// 일정 수정·삭제 권한: 본인 것이거나, 자기 팀 일정을 관리자가.
// 지점 공통(team_id NULL, 강의 등)은 등록자 본인 또는 총관리자만 — 다른 팀 관리자가
// 남의 강의를 지우는 일이 없도록.
// 일정에 손대는 기준 — 본인 것은 본인, 남의 것과 팀 공유는 부지점장 이상
// (2026-08-05 사용자: 「부지점장이나 총관리자만, 팀원은 본인이 넣은 것만」).
// 관리자로 임명된 팀장·부팀장은 조직도를 고칠 뿐 남의 일정을 지우지 않는다.
function canEditEvent(user, e) {
  if (e.member_email === user.email) return true;
  if (e.team_id == null) return user.isSuper;
  return canSetGoal(user) && canWriteTeam(user, e.team_id);
}

route("POST", /^\/events\/(\d+)$/, false, async (req, res, user, m) => {
  const e = db.prepare("SELECT * FROM events WHERE id = ?").get(Number(m[1]));
  if (!e) return send(res, 404, { error: "없음" });
  if (!canEditEvent(user, e)) return send(res, 403, { error: "본인 일정만" });
  if (e.source === "myguardian") return send(res, 403, { error: "연동 일정은 마이가디언에서 수정합니다" });
  const b = await readJson(req);
  // 바꾸려는 대상도 검사한다 — 안 그러면 팀원이 자기 일정을 팀 공유나 남의 일정으로 바꾼다
  const nextEmail = b.memberEmail !== undefined
    ? (b.memberEmail ? String(b.memberEmail).toLowerCase() : null) : e.member_email;
  if (nextEmail !== e.member_email && !canSetGoal(user)) return send(res, 403, { error: "대상 변경은 부지점장 이상만" });
  if (nextEmail == null && !canSetGoal(user)) return send(res, 403, { error: "팀 일정은 부지점장 이상만" });
  // 남의 달력에 심지 못하게 — 대상은 내가 쓸 수 있는 팀 소속이어야 한다
  if (nextEmail && nextEmail !== user.email) {
    const t = getMember(db, nextEmail);
    if (!t || !canWriteTeam(user, t.team_id)) return send(res, 403, { error: "다른 팀 구성원입니다" });
  }
  if (b.date !== undefined && !isDate(b.date))
    return send(res, 400, { error: "날짜는 2026-08-01 형식으로 넣어 주세요: " + b.date });
  const nextDetail = b.detail !== undefined ? JSON.stringify(b.detail).slice(0, 2000) : e.detail;
  db.prepare("UPDATE events SET member_email = ?, date = ?, start = ?, end = ?, kind = ?, title = ?, place = ?, detail = ? WHERE id = ?")
    .run(nextEmail, b.date ?? e.date, b.start ?? e.start, b.end ?? e.end,
         b.kind ?? e.kind, b.title ?? e.title, b.place ?? e.place, nextDetail, e.id);
  send(res, 200, { ok: true });
});

route("DELETE", /^\/events\/(\d+)$/, false, (req, res, user, m) => {
  const e = db.prepare("SELECT * FROM events WHERE id = ?").get(Number(m[1]));
  // 마이가디언에서 넘어온 일정은 여기서 손대지 않는다 — 수정만 막고 삭제는 열려 있었다
  if (e && e.source === "myguardian")
    return send(res, 400, { error: "마이가디언 일정은 마이가디언에서 고칩니다" });
  if (!e) return send(res, 404, { error: "없음" });
  if (!canEditEvent(user, e)) return send(res, 403, { error: "권한 없음" });
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
  const date = b.date || today();
  const prev = db.prepare("SELECT * FROM attendance WHERE email = ? AND date = ?").get(user.email, date) || {};
  // 보낸 값만 갱신 — 출근일정만 고쳐도 출석 체크가 풀리지 않는다
  const present = b.present != null ? (b.present ? 1 : 0) : (prev.present || 0);
  // 출석 체크 시각은 처음 체크될 때 한 번 찍고 유지한다
  const checkedAt = present && !prev.checked_at ? now() : (present ? prev.checked_at : null);
  db.prepare(
    `INSERT INTO attendance (email, date, present, reason, aitom, work, lunch, afternoon, note, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(email, date) DO UPDATE SET present = excluded.present, reason = excluded.reason,
       aitom = excluded.aitom, work = excluded.work, lunch = excluded.lunch,
       afternoon = excluded.afternoon, note = excluded.note, checked_at = excluded.checked_at`
  ).run(
    user.email, date, present,
    b.reason != null ? b.reason : (prev.reason || ""),
    b.aitom != null ? (b.aitom ? 1 : 0) : (prev.aitom || 0),
    b.work != null ? b.work : (prev.work || ""),
    b.lunch != null ? b.lunch : (prev.lunch || ""),
    b.afternoon != null ? b.afternoon : (prev.afternoon || ""),
    b.note != null ? b.note : (prev.note || ""),
    checkedAt
  );
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
  if (!canWriteTeam(user, teamId)) return send(res, 403, { error: "권한 없음" });
  // 「전체」를 그대로 저장하면 분모가 「지금 인원」이 된다 — 팀원이 늘면 지난달 100%가
  // 80%로 떨어진다. 부여하는 순간의 명단을 박아 둔다.
  let targets = b.targets;
  if (!targets || targets === "전체") {
    targets = db.prepare("SELECT email FROM members WHERE team_id = ? AND active = 1").all(teamId).map(x => x.email);
    if (!targets.length) targets = "전체";        // 명단이 비었으면 옛 방식으로 둔다
  }
  const r = db.prepare("INSERT INTO tasks (team_id, title, content, targets, status, assigned, due) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(teamId, b.title, b.content || "", JSON.stringify(targets), "요청", today(), b.due || null);
  send(res, 200, { id: Number(r.lastInsertRowid) });
});

// 미션 상태(요청/진행중/완료) API는 걷어냈다 (2026-08-03).
// 화면에서 쓴 적이 없고, 달성 여부는 task_done(사람마다 「확인」을 눌렀는지)이 판정한다.
// 「완료」가 두 군데서 각각 정해지면 어느 쪽이 맞는지 아무도 모르게 된다.

route("DELETE", /^\/tasks\/(\d+)$/, true, (req, res, user, m) => {
  const t = db.prepare("SELECT * FROM tasks WHERE id = ?").get(Number(m[1]));
  if (!t || !canWriteTeam(user, t.team_id)) return send(res, 403, { error: "권한 없음" });
  db.prepare("DELETE FROM tasks WHERE id = ?").run(t.id);
  send(res, 200, { ok: true });
});

route("DELETE", /^\/notices\/(\d+)$/, true, (req, res, user, m) => {
  const n = db.prepare("SELECT * FROM notices WHERE id = ?").get(Number(m[1]));
  if (!n || !canWriteTeam(user, n.team_id)) return send(res, 403, { error: "권한 없음" });
  db.prepare("DELETE FROM notices WHERE id = ?").run(n.id);
  send(res, 200, { ok: true });
});

// ---- TA 일지 ----
// 엑셀형 그리드 전제: 조회는 월 단위 한 방, 저장은 여러 줄 한 방(붙여넣기 대응).
const TA_FIELDS = ["date", "cand_name", "gender", "age", "region", "safe_phone", "real_phone", "result", "reject_sms", "cis_sms", "note", "flag", "stage"];

// 도입 단계 — 순서가 곧 깔때기다. 빈 값은 「통화」로 본다(일지를 쓴 것 자체가 통화다).
const STAGES = ["통화", "면접", "위촉", "거절"];

// 잠금 상태 — 화면이 처음 물어볼지 말지 정한다
route("GET", /^\/ta\/lock$/, false, (req, res, user) => {
  const row = db.prepare("SELECT until FROM ta_unlock WHERE email = ?").get(user.email);
  send(res, 200, {
    enabled: taLockEnabled(),
    unlocked: taUnlocked(user),
    until: row ? row.until : null,
    canSetPassword: isBranchHead(user),
    hours: TA_UNLOCK_HOURS,
    keepMonths: TA_KEEP_MONTHS
  });
});

// 비밀번호를 계속 찍어보는 것을 막는다. 짧은 공용 비밀번호라 시도를 자유롭게 두면
// 명단에 있는 누구든(또는 로그인된 기기를 주운 사람이) 결국 맞힌다.
const unlockTries = new Map();          // 이메일 → { n, until }
route("POST", /^\/ta\/unlock$/, false, async (req, res, user) => {
  const now = Date.now();
  const t = unlockTries.get(user.email) || { n: 0, until: 0 };
  if (t.until > now)
    return send(res, 429, { error: "너무 여러 번 틀렸습니다. " + Math.ceil((t.until - now) / 60000) + "분 뒤에 다시 시도해 주세요." });
  const b = await readJson(req);
  if (!checkTaPassword(b.password || "")) {
    t.n++;
    if (t.n >= 5) { t.until = now + 10 * 60e3; t.n = 0; }
    unlockTries.set(user.email, t);
    return send(res, 403, { error: "비밀번호가 맞지 않습니다" });
  }
  unlockTries.delete(user.email);
  send(res, 200, { ok: true, until: unlockTa(user) });
});

// 공용 비밀번호 설정·변경 — 지점장·총관리자만
route("POST", /^\/ta\/password$/, false, async (req, res, user) => {
  if (!isBranchHead(user)) return send(res, 403, { error: "지점장·총관리자만" });
  const b = await readJson(req);
  const pw = String(b.password || "").trim();
  if (pw.length < 4) return send(res, 400, { error: "비밀번호를 4자 이상으로 정해 주세요" });
  setTaPassword(pw);
  // 비밀번호를 바꾸면 기존 해제는 모두 무효 — 바꾼 이유가 있을 것이다
  db.prepare("DELETE FROM ta_unlock").run();
  unlockTa(user);
  send(res, 200, { ok: true });
});

// 열람 기록 — 지점장·총관리자만 본다
// 백업 상태 — 총관리자·지점장만. 백업이 조용히 멈춰 있는 것을 모르는 게 가장 위험하다.
// 면접관 명단 — 팀원이 아니라 따로 관리하는 이름 목록(본부 면접관 등).
// 조직도에 넣으면 팀 인원이 되어 집계·권한이 어긋나므로 설정값으로 둔다.
// 1차와 2차의 면접관이 다르다 — 구분마다 따로 담는다 { TS1: [...], TS2: [...] }
function interviewerMap() {
  try { return JSON.parse(getSetting(db, "면접관명단") || "{}") || {}; } catch { return {}; }
}
route("GET", /^\/settings\/interviewers$/, false, (req, res) => {
  send(res, 200, interviewerMap());
});

route("POST", /^\/settings\/interviewers$/, false, async (req, res, user) => {
  if (!user.isManager) return send(res, 403, { error: "관리자만" });
  const b = await readJson(req);
  if (!b.kind || !Array.isArray(b.list)) return send(res, 400, { error: "구분과 명단이 필요합니다" });
  const names = b.list.map(x => String(x).trim()).filter(Boolean)
    .filter((x, i, a) => a.indexOf(x) === i).slice(0, 100);
  const map = interviewerMap();
  map[String(b.kind)] = names;
  setSetting(db, "면접관명단", JSON.stringify(map));
  send(res, 200, map);
});

route("GET", /^\/admin\/backup$/, false, (req, res, user) => {
  if (!isBranchHead(user)) return send(res, 403, { error: "지점장·총관리자만" });
  try {
    const raw = readFileSync("/var/lib/ourbranch/backup-status.json", "utf8");
    const st = JSON.parse(raw);
    const age = (Date.now() - new Date(st["시각"]).getTime()) / 3600e3;
    send(res, 200, { ...st, "지난시간": Math.round(age), "정상": !!st["성공"] && age < 36 });
  } catch {
    send(res, 200, { "정상": false, "사유": "백업 기록이 없습니다" });
  }
});

route("GET", /^\/ta\/access$/, false, (req, res, user) => {
  if (!isBranchHead(user)) return send(res, 403, { error: "지점장·총관리자만" });
  send(res, 200, db.prepare("SELECT * FROM ta_access ORDER BY id DESC LIMIT 200").all());
});

route("GET", /^\/ta$/, false, (req, res, user) => {
  if (!taUnlocked(user)) return send(res, 403, { error: "TA 일지 비밀번호를 입력해 주세요", taLocked: true });
  const q = new URL(req.url, "http://x").searchParams;
  // LIKE는 %·_ 와일드카드가 통해서 전 기간이 덤프된다 — 범위 비교로 막는다
  const month = /^\d{4}-\d{2}$/.test(q.get("month") || "") ? q.get("month") : today().slice(0, 7);
  // TA 일지는 지점 전체가 함께 본다 (2026-08-02 사용자 지시).
  // 알바몬 등에서 걸러야 할 상대를 지점이 공유하는 것이 이 일지의 주된 쓸모다 —
  // 팀별로 갈라두면 옆 팀이 이미 거른 사람에게 또 연락하게 된다.
  // 쓰기(수정·삭제)는 그대로 본인·관리자만.
  const flagged = q.get("flagged") === "1";
  const list = flagged
    // 주의 표시는 기간을 가리지 않는다 — 연락하기 전에 훑어보는 명단이다
    ? db.prepare("SELECT * FROM ta_logs WHERE flag <> '' ORDER BY date DESC, id DESC LIMIT 500").all()
    : db.prepare("SELECT * FROM ta_logs WHERE date >= ? AND date <= ? ORDER BY date, id")
        .all(month + "-00", month + "-99");
  send(res, 200, list);
});

// 도입 현황 — 숫자만 돌려준다(후보자 이름·연락처 없음).
// 그래서 TA 일지 잠금과 무관하게 열어도 개인정보 문제가 없다.
route("GET", /^\/recruit$/, false, (req, res, user) => {
  const q = new URL(req.url, "http://x").searchParams;
  const month = /^\d{4}-\d{2}$/.test(q.get("month") || "") ? q.get("month") : today().slice(0, 7);
  // 숫자만 주더라도 「누가 몇 건」은 자료다 — 열람 범위를 지킨다(자기 팀, 전체열람이면 전 팀)
  const rows = db.prepare("SELECT team_id, author, author_email, stage FROM ta_logs WHERE date >= ? AND date <= ?")
    .all(month + "-00", month + "-99")
    .filter(r => canSeeTeam(user, r.team_id));
  const blank = () => Object.fromEntries(STAGES.map(s => [s, 0]));
  const total = blank(), byTeam = {}, byMember = {};
  for (const r of rows) {
    const st = STAGES.includes(r.stage) ? r.stage : "통화";
    total[st]++;
    const t = (byTeam[r.team_id] = byTeam[r.team_id] || blank());
    t[st]++;
    const key = r.author_email || r.author;
    const m = (byMember[key] = byMember[key] || { email: r.author_email, name: r.author, ...blank() });
    m[st]++;
  }
  send(res, 200, {
    month, stages: STAGES, total,
    byTeam: Object.entries(byTeam).map(([id, v]) => ({ teamId: id === "null" ? null : Number(id), ...v })),
    byMember: Object.values(byMember)
  });
});

// 지난 보고 — 지금 쓰고 있는 날짜 말고, 가장 가까운 날의 내 보고 한 건.
// 「전날 저녁에 다음날 보고를 미리 쓴다」가 실제 습관이라 미래 날짜도 후보다.
// 가까운 과거를 먼저 보고, 없으면 가까운 미래를 본다. 본인 것만.
route("GET", /^\/attendance\/last$/, false, (req, res, user) => {
  const q = new URL(req.url, "http://x").searchParams;
  const from = isDate(q.get("date")) ? q.get("date") : today();
  const row = db.prepare(
    `SELECT * FROM attendance
     WHERE email = ? AND date <> ? AND (work <> '' OR lunch <> '' OR afternoon <> '' OR note <> '')
     ORDER BY CASE WHEN date < ? THEN 0 ELSE 1 END, ABS(julianday(date) - julianday(?))
     LIMIT 1`
  ).get(user.email, from, from, from);
  send(res, 200, row || {});
});

route("POST", /^\/ta$/, false, async (req, res, user) => {
  if (!taUnlocked(user)) return send(res, 403, { error: "TA 일지 비밀번호를 입력해 주세요", taLocked: true });
  const b = await readJson(req);                          // { teamId?, rows: [...] }
  const teamId = b.teamId ?? user.teamId;
  if (teamId == null || !Array.isArray(b.rows)) return send(res, 400, { error: "팀·행이 없습니다" });
  if (!canWriteTeam(user, teamId)) return send(res, 403, { error: "권한 없음" });
  const ins = db.prepare(`INSERT INTO ta_logs (team_id, author, author_email, ${TA_FIELDS.join(", ")})
    VALUES (?, ?, ?${", ?".repeat(TA_FIELDS.length)})`);
  // 형식 검사는 한 줄이라도 틀리면 아예 시작하지 않는다 — 절반만 저장되는 일이 없게
  for (const r of b.rows) {
    if (r.date && !isDate(r.date))
      return send(res, 400, { error: "날짜는 2026-08-01 형식으로 넣어 주세요: " + r.date });
  }
  const ids = [];
  try {
  tx(() => {
  for (const r of b.rows) {
    if (!r.date) continue;
    // 일지는 각 팀원이 본인 것으로 넣는다. 남의 것으로 넣는 건 관리자만.
    // 담당자는 이메일로 지정한다 — 동명이인이 섞이지 않게.
    let authorEmail = r.authorEmail || (r.author ? emailForName(r.author) : user.email);
    let author = r.author || user.name;
    if (r.authorEmail) {
      const t = getMember(db, r.authorEmail);
      if (t) author = t.name;
    }
    if (!authorEmail) authorEmail = r.author === user.name ? user.email : null;
    if (!user.isManager && authorEmail !== user.email) throw new Error("본인 일지만 입력할 수 있습니다");
    ids.push(Number(ins.run(teamId, author, authorEmail, ...TA_FIELDS.map(f => String(r[f] ?? ""))).lastInsertRowid));
  }
  });
  } catch (e) { return send(res, 403, { error: e.message || "저장하지 못했습니다" }); }
  send(res, 200, { ids });
});

route("POST", /^\/ta\/(\d+)$/, false, async (req, res, user, m) => {
  if (!taUnlocked(user)) return send(res, 403, { error: "TA 일지 비밀번호를 입력해 주세요", taLocked: true });
  const row = db.prepare("SELECT * FROM ta_logs WHERE id = ?").get(Number(m[1]));
  // 읽기는 지점 전체지만 고치는 것은 자기 팀만. can_view_all은 「보는」 권한이다.
  if (!row) return send(res, 404, { error: "없음" });
  if (!isOwner(user, row.author_email, row.author) && !(user.isManager && canWriteTeam(user, row.team_id)))
    return send(res, 403, { error: "본인 기록만" });
  const b = await readJson(req);
  const sets = TA_FIELDS.filter(f => b[f] != null);
  // 담당자 변경은 관리자만 — 아니면 자기 실적을 남 이름으로 떠넘길 수 있다
  if (b.author != null && b.author !== row.author) {
    if (!user.isManager) return send(res, 403, { error: "담당자 변경은 관리자만" });
    sets.push("author");
    // 이름만 바꾸면 동명이인 중 누구인지 모른다 — 이메일도 함께 옮긴다
    const em = b.authorEmail || emailForName(b.author);
    if (em) db.prepare("UPDATE ta_logs SET author_email = ? WHERE id = ?").run(em, row.id);
  }
  if (!sets.length) return send(res, 400, { error: "고칠 값이 없습니다" });
  db.prepare(`UPDATE ta_logs SET ${sets.map(f => f + " = ?").join(", ")} WHERE id = ?`)
    .run(...sets.map(f => String(b[f])), row.id);
  send(res, 200, { ok: true });
});

route("DELETE", /^\/ta\/(\d+)$/, false, (req, res, user, m) => {
  if (!taUnlocked(user)) return send(res, 403, { error: "TA 일지 비밀번호를 입력해 주세요", taLocked: true });
  const row = db.prepare("SELECT * FROM ta_logs WHERE id = ?").get(Number(m[1]));
  if (!row) return send(res, 404, { error: "없음" });
  if (!isOwner(user, row.author_email, row.author) && !(user.isManager && canWriteTeam(user, row.team_id)))
    return send(res, 403, { error: "본인 기록만" });
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
  if (!canWriteTeam(user, teamId)) return send(res, 403, { error: "권한 없음" });
  for (const r of b.rows) {
    if (r.contract_date && !isDate(r.contract_date))
      return send(res, 400, { error: "계약일은 2026-08-01 형식으로 넣어 주세요: " + r.contract_date });
  }
  const ins = db.prepare("INSERT INTO perf (team_id, month, member, member_email, contract_date, premium, canp, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const ids = [];
  try {
  tx(() => {
  for (const r of b.rows) {
    if (!r.member && !r.memberEmail) continue;
    // 대상은 이메일로 특정한다 — 동명이인이 섞이지 않게
    const em = r.memberEmail || emailForName(r.member) || (r.member === user.name ? user.email : null);
    const t = em ? getMember(db, em) : null;
    const name = (t && t.name) || r.member;
    // 팀원은 자기 업적만, 부지점장(관리자)은 팀 전체 입력 가능
    if (!user.isManager && em !== user.email) throw new Error("본인 업적만 입력할 수 있습니다");
    ids.push(Number(ins.run(teamId, b.month, name, em, r.contract_date || "", num(r.premium), num(r.canp), r.note || "").lastInsertRowid));
  }
  });
  } catch (e) { return send(res, 403, { error: e.message || "저장하지 못했습니다" }); }
  send(res, 200, { ids });
});

route("POST", /^\/perf\/(\d+)$/, false, async (req, res, user, m) => {
  const row = db.prepare("SELECT * FROM perf WHERE id = ?").get(Number(m[1]));
  if (!row) return send(res, 404, { error: "없음" });
  if (!isOwner(user, row.member_email, row.member) && !(user.isManager && canWriteTeam(user, row.team_id)))
    return send(res, 403, { error: "본인 업적만" });
  const b = await readJson(req);
  if (b.contract_date !== undefined && b.contract_date && !isDate(b.contract_date))
    return send(res, 400, { error: "계약일은 2026-08-01 형식으로 넣어 주세요: " + b.contract_date });
  db.prepare("UPDATE perf SET contract_date = ?, premium = ?, canp = ?, note = ? WHERE id = ?")
    .run(b.contract_date ?? row.contract_date, num(b.premium ?? row.premium),
         num(b.canp ?? row.canp), b.note ?? row.note, row.id);
  send(res, 200, { ok: true });
});

route("DELETE", /^\/perf\/(\d+)$/, false, (req, res, user, m) => {
  const row = db.prepare("SELECT * FROM perf WHERE id = ?").get(Number(m[1]));
  if (!row) return send(res, 404, { error: "없음" });
  if (!isOwner(user, row.member_email, row.member) && !(user.isManager && canWriteTeam(user, row.team_id)))
    return send(res, 403, { error: "본인 업적만" });
  db.prepare("DELETE FROM perf WHERE id = ?").run(row.id);
  send(res, 200, { ok: true });
});

route("POST", /^\/perf\/goals$/, true, async (req, res, user) => {
  const b = await readJson(req);                          // { teamId?, month, goals: [{member, goal}] }
  const teamId = b.teamId ?? user.teamId;
  if (teamId == null || !b.month || !Array.isArray(b.goals)) return send(res, 400, { error: "팀·월·목표가 없습니다" });
  if (!canWriteTeam(user, teamId)) return send(res, 403, { error: "권한 없음" });
  if (!canSetGoal(user)) return send(res, 403, { error: "목표는 부지점장 이상만 정합니다" });
  // 목표의 주인은 이메일이다 — 같은 팀에 동명이인이 있어도 서로를 덮어쓰지 않는다.
  // 이메일이 없는 자리(명단 밖 이름)는 「이름:홍길동」을 열쇠로 쓴다.
  const keyOf = (email, name) => email || ("이름:" + name);
  const prevOf = db.prepare("SELECT * FROM perf_goals WHERE team_id = ? AND month = ? AND member_key = ?");
  const up = db.prepare(
    `INSERT INTO perf_goals (team_id, month, member_key, member, member_email, goal, cases, intro) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(team_id, month, member_key) DO UPDATE SET
       member = excluded.member, member_email = excluded.member_email,
       goal = excluded.goal, cases = excluded.cases, intro = excluded.intro`
  );
  // 대상은 그 팀 사람이어야 한다. 안 그러면 1팀 부지점장이 2팀원 목표를 자기 팀에
  // 끼워 넣을 수 있고, 대소문자만 바꾼 주소로 같은 사람 목표가 둘이 된다
  // (코덱스 검증 2026-08-05).
  const emailOf = g =>
    (g.memberEmail ? String(g.memberEmail).toLowerCase() : "") || emailForName(g.member) || null;
  for (const g of b.goals) {
    const em = emailOf(g);
    if (!em) continue;                                    // 이메일 없는 이름 자리는 종전대로
    const tm = getMember(db, em);
    if (!tm || tm.team_id !== teamId)
      return send(res, 400, { error: "그 팀 사람이 아닙니다: " + (g.member || em) });
  }
  // 보낸 값만 갱신 — 목표만 고쳤다고 도입 실적이 0이 되면 안 된다.
  // 화면은 「바뀐 항목만」 보낸다. 빈 칸을 그대로 보내 목표가 조용히 지워지던 사고를 막는다.
  tx(() => {
    for (const g of b.goals) {
      if (!g.member) continue;
      if (g.goal === undefined && g.cases === undefined && g.intro === undefined) continue;   // 바뀐 게 없으면 건드리지 않는다
      const em = emailOf(g);
      const key = keyOf(em, g.member);
      const prev = prevOf.get(teamId, b.month, key) || {};
      up.run(teamId, b.month, key, g.member, em,
        g.goal !== undefined ? g.goal : (prev.goal || ""),
        g.cases !== undefined ? (num(g.cases) || 0) : (prev.cases || 0),
        g.intro !== undefined ? (num(g.intro) || 0) : (prev.intro || 0));
    }
  });
  send(res, 200, { ok: true });
});

// 지난달 일정 복사 — 반복 일정(조회·스터디·교육)을 매달 다시 넣지 않게.
// 같은 날짜 위치(같은 일수)로 옮기고, 이미 있는 건 건너뛴다.
route("POST", /^\/events\/copy-month$/, false, async (req, res, user) => {
  const b = await readJson(req);
  const from = String(b.from || ""), to = String(b.to || "");
  if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to))
    return send(res, 400, { error: "월 형식이 올바르지 않습니다" });
  const teamId = b.teamId ?? user.teamId;
  if (!canWriteTeam(user, teamId)) return send(res, 403, { error: "권한 없음" });

  const onlyTeam = !!b.onlyTeam;          // 팀 공유 일정만 복사할지
  const src = db.prepare("SELECT * FROM events WHERE date >= ? AND date <= ? AND team_id = ? AND source IS NULL")
    .all(from + "-00", from + "-99", teamId)
    .filter(e => onlyTeam ? !e.member_email : true)
    // 옮기는 것도 새로 만드는 것이다 — POST /events와 같은 선으로 가른다.
    // isManager로 두면 관리자로 임명된 팀장이 이 길로 지점 일정을 만들 수 있다
    // (2026-08-05 자체 점검).
    .filter(e => canSetGoal(user) || e.member_email === user.email);

  // 날짜(3일 → 3일)로 옮기면 요일이 어긋난다 — 월요일 조회가 수요일로 간다.
  // 「그 달의 몇째 주 무슨 요일」을 지켜서 옮긴다. 다섯째 주가 없으면 마지막 같은 요일로.
  function moveByWeekday(dateStr, toMonth) {
    const d = new Date(dateStr + "T00:00:00");
    const nth = Math.floor((d.getDate() - 1) / 7);        // 0-based 몇째 주
    const dow = d.getDay();
    const y = Number(toMonth.slice(0, 4)), mo = Number(toMonth.slice(5, 7)) - 1;
    const first = new Date(y, mo, 1);
    let day = 1 + ((dow - first.getDay() + 7) % 7) + nth * 7;
    const last = new Date(y, mo + 1, 0).getDate();
    while (day > last) day -= 7;                          // 다섯째 주가 없으면 한 주 당긴다
    return y + "-" + String(mo + 1).padStart(2, "0") + "-" + String(day).padStart(2, "0");
  }
  const exists = db.prepare(
    "SELECT 1 FROM events WHERE date = ? AND team_id = ? AND kind = ? AND title = ? AND IFNULL(member_email,'') = IFNULL(?,'')"
  );
  const ins = db.prepare("INSERT INTO events (team_id, member_email, date, start, end, kind, title, place) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  let copied = 0, skipped = 0;
  for (const e of src) {
    const nd = moveByWeekday(e.date, to);
    if (exists.get(nd, teamId, e.kind, e.title, e.member_email)) { skipped++; continue; }
    ins.run(teamId, e.member_email, nd, e.start, e.end, e.kind, e.title, e.place);
    copied++;
  }
  send(res, 200, { copied, skipped, total: src.length });
});

// ---- 초대·승인 ----
// 초대는 아무나 만든다 (카톡으로 링크 전달). 초대 자체로는 권한이 생기지 않는다.
route("POST", /^\/invites$/, false, async (req, res, user) => {
  const b = await readJson(req);
  // 팀원도 초대를 만들 수 있다 — 다만 자기 팀, 자기 직급 아래로만.
  // 초대에 심어 둔 직급은 승인 화면에 미리 채워져 뜬다(무심코 누르게 된다).
  let teamId = b.teamId !== undefined ? (b.teamId ?? null) : user.teamId;
  if (!user.isManager) teamId = user.teamId;
  // 관리자든 아니든 최종 팀에 쓰기 권한이 있어야 한다.
  // 관리자만 검사하면 팀 없는 구성원이 그냥 통과한다 (코덱스 검증 2026-08-05).
  if (!canWriteTeam(user, teamId)) return send(res, 403, { error: "권한 없는 팀입니다" });
  if (!canAssignRole(user, b.role))
    return send(res, 403, { error: "자기보다 높은 직급으로는 초대할 수 없습니다" });
  const code = Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);
  const expires = new Date(Date.now() + 14 * 86400e3).toISOString();
  db.prepare("INSERT INTO invites (code, team_id, role, by_email, by_name, created, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(code, teamId, b.role || "팀원", user.email, user.name, now(), expires);
  const team = teamId != null ? db.prepare("SELECT name FROM teams WHERE id = ?").get(teamId) : null;
  send(res, 200, { code, teamName: team ? team.name : "", role: b.role || "팀원", expiresAt: expires });
});

// 명단 전용 계정(이메일 모른 채 이름만 등록한 사람)을 실제 구글 계정으로 이어받는다.
// 이걸 안 하면 조직도에 같은 사람이 두 줄로 갈라지고, 미리 넣어둔 일정·업적이
// 본인에게 붙지 않는다.
function mergeMember(fromEmail, toEmail) {
  if (!fromEmail || !toEmail || fromEmail === toEmail) return;
  const moves = [
    ["UPDATE events SET member_email = ? WHERE member_email = ?"],
    ["UPDATE ta_logs SET author_email = ? WHERE author_email = ?"],
    ["UPDATE perf SET member_email = ? WHERE member_email = ?"],
    ["UPDATE perf_goals SET member_email = ? WHERE member_email = ?"],
    ["UPDATE members SET recruiter_email = ? WHERE recruiter_email = ?"],
    // 서류·교육도 주인을 따라간다 — 안 옮기면 본인이 자기 합격증을 못 본다
    ["UPDATE docs SET owner_email = ? WHERE owner_email = ?"],
    ["UPDATE trainings SET member_email = ? WHERE member_email = ?"]
  ];
  for (const [sql] of moves) db.prepare(sql).run(toEmail, fromEmail);
  // 목표 열쇠 옮기기 — 같은 팀·같은 달에 양쪽 목표가 있으면 열쇠가 부딪힌다.
  // OR REPLACE로 밀어붙이면 남아 있던 쪽이 조용히 사라진다(코덱스 검증 2026-08-05).
  // 빈 칸만 채우고, 이미 값이 있는 칸은 계정 쪽을 지킨다.
  const dupe = db.prepare("SELECT * FROM perf_goals WHERE member_key = ?").all(fromEmail);
  const keep = db.prepare("SELECT * FROM perf_goals WHERE team_id = ? AND month = ? AND member_key = ?");
  const fill = db.prepare("UPDATE perf_goals SET goal = ?, cases = ?, intro = ? WHERE team_id = ? AND month = ? AND member_key = ?");
  const move = db.prepare("UPDATE perf_goals SET member_key = ? WHERE team_id = ? AND month = ? AND member_key = ?");
  const drop = db.prepare("DELETE FROM perf_goals WHERE team_id = ? AND month = ? AND member_key = ?");
  for (const g of dupe) {
    const to = keep.get(g.team_id, g.month, toEmail);
    if (!to) { move.run(toEmail, g.team_id, g.month, fromEmail); continue; }
    fill.run(to.goal || g.goal || "", to.cases || g.cases || 0, to.intro || g.intro || 0,
             g.team_id, g.month, toEmail);
    drop.run(g.team_id, g.month, fromEmail);
  }
  // 출석·일일보고는 내용이 있는 기록이다. 같은 날 두 줄이 있으면 그냥 버리지 않고
  // 빈 칸만 채운다 — 버리면 그날 오전·점심·오후·특이사항이 통째로 사라진다.
  const attFields = ["reason", "work", "lunch", "afternoon", "note"];
  for (const from of db.prepare("SELECT * FROM attendance WHERE email = ?").all(fromEmail)) {
    const to = db.prepare("SELECT * FROM attendance WHERE email = ? AND date = ?").get(toEmail, from.date);
    if (!to) {
      db.prepare("UPDATE attendance SET email = ? WHERE id = ?").run(toEmail, from.id);
      continue;
    }
    const fill = attFields.filter(f => !String(to[f] || "").trim() && String(from[f] || "").trim());
    if (fill.length)
      db.prepare(`UPDATE attendance SET ${fill.map(f => f + " = ?").join(", ")} WHERE id = ?`)
        .run(...fill.map(f => from[f]), to.id);
    if (!to.present && from.present)
      db.prepare("UPDATE attendance SET present = 1, checked_at = ? WHERE id = ?").run(from.checked_at, to.id);
    db.prepare("DELETE FROM attendance WHERE id = ?").run(from.id);
  }
  // 확인·달성·참석은 「눌렀다」는 표시뿐이라 겹치면 하나만 남기면 된다
  for (const [sql, del] of [
    ["UPDATE OR IGNORE notice_reads SET email = ? WHERE email = ?", "DELETE FROM notice_reads WHERE email = ?"],
    ["UPDATE OR IGNORE task_done SET email = ? WHERE email = ?", "DELETE FROM task_done WHERE email = ?"],
    ["UPDATE OR IGNORE event_attendees SET email = ? WHERE email = ?", "DELETE FROM event_attendees WHERE email = ?"]
  ]) {
    db.prepare(sql).run(toEmail, fromEmail);
    db.prepare(del).run(fromEmail);
  }
  // 일정 세부(면접관·교육 대상)도 JSON 안에 이메일이 들어 있다
  for (const e of db.prepare("SELECT id, detail FROM events WHERE detail <> ''").all()) {
    let d;
    try { d = JSON.parse(e.detail); } catch { continue; }
    if (!d || !Array.isArray(d.people) || !d.people.includes(fromEmail)) continue;
    d.people = d.people.map(x => (x === fromEmail ? toEmail : x)).filter((x, i, a) => a.indexOf(x) === i);
    db.prepare("UPDATE events SET detail = ? WHERE id = ?").run(JSON.stringify(d), e.id);
  }
  // 미션 대상은 이메일 배열(JSON)이라 위 UPDATE로는 안 옮겨진다.
  // 안 옮기면 자리를 이어받은 사람의 미션이 사라지고 달성률 분모만 남는다.
  for (const t of db.prepare("SELECT id, targets FROM tasks").all()) {
    let arr;
    try { arr = JSON.parse(t.targets); } catch { continue; }
    if (!Array.isArray(arr) || !arr.includes(fromEmail)) continue;
    const next = arr.map(e => (e === fromEmail ? toEmail : e)).filter((e, i, a) => a.indexOf(e) === i);
    db.prepare("UPDATE tasks SET targets = ? WHERE id = ?").run(JSON.stringify(next), t.id);
  }
  db.prepare("DELETE FROM members WHERE email = ?").run(fromEmail);
}

// 승인 — 지점장·부지점장·총관리자
route("POST", /^\/pending\/approve$/, false, async (req, res, user) => {
  if (!canApprove(user)) return send(res, 403, { error: "승인 권한이 없습니다" });
  const b = await readJson(req);
  if (!b.email) return send(res, 400, { error: "대상이 없습니다" });
  const email = String(b.email).toLowerCase();
  const p = db.prepare("SELECT * FROM pending WHERE email = ?").get(email);
  if (!p) return send(res, 404, { error: "신청이 없습니다" });
  // 명단 전용 자리를 이어받는 경우 — 그 자리의 팀·직급·도입자를 그대로 물려받는다
  let from = null;
  if (b.mergeFrom) {
    from = getMember(db, String(b.mergeFrom).toLowerCase());
    if (!from) return send(res, 404, { error: "이어받을 자리가 없습니다" });
    if (!canWriteTeam(user, from.team_id)) return send(res, 403, { error: "권한 없는 팀입니다" });
  }
  const teamId = from ? from.team_id
    : (b.teamId !== undefined ? (b.teamId ?? null) : (p.team_id ?? user.teamId));
  if (!canWriteTeam(user, teamId)) return send(res, 403, { error: "권한 없는 팀입니다" });
  const grantRole = (from && from.role) || b.role || p.role || "팀원";
  if (!canAssignRole(user, grantRole))
    return send(res, 403, { error: "자기보다 높은 직급으로는 승인할 수 없습니다" });
  const upsert = db.prepare(
    `INSERT INTO members (email, name, team_id, role, recruiter_email) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET name = excluded.name, team_id = excluded.team_id,
       role = excluded.role, recruiter_email = excluded.recruiter_email`
  );
  // 자리 이어받기는 통째로 되거나 통째로 안 돼야 한다 — 반쪽만 옮겨지면 기록의 주인이 갈린다
  tx(() => {
    upsert.run(email, (from && from.name) || b.name || p.name || "", teamId,
               grantRole, from ? from.recruiter_email : null);
    if (from) mergeMember(from.email, email);
    db.prepare("DELETE FROM pending WHERE email = ?").run(email);
  });
  send(res, 200, { ok: true, merged: !!from });
});

route("POST", /^\/pending\/reject$/, false, async (req, res, user) => {
  if (!canApprove(user)) return send(res, 403, { error: "승인 권한이 없습니다" });
  const b = await readJson(req);
  const email = String(b.email || "").toLowerCase();
  const p = db.prepare("SELECT * FROM pending WHERE email = ?").get(email);
  if (!p) return send(res, 404, { error: "신청이 없습니다" });
  if (!(user.seesAll || p.team_id == null || p.team_id === user.teamId))
    return send(res, 403, { error: "권한 없음" });
  db.prepare("DELETE FROM pending WHERE email = ?").run(email);
  send(res, 200, { ok: true });
});

// ---- 관리 (팀·구성원·설정) ----
// 팀 신설·이름 변경·삭제는 지점 구조를 바꾸는 일 — 총관리자·지점장만
route("POST", /^\/admin\/teams$/, true, async (req, res, user) => {
  if (!isBranchHead(user)) return send(res, 403, { error: "총관리자·지점장만" });
  const b = await readJson(req);
  if (!b.name) return send(res, 400, { error: "팀 이름이 없습니다" });
  const r = db.prepare("INSERT INTO teams (name) VALUES (?)").run(b.name);
  send(res, 200, { id: Number(r.lastInsertRowid) });
});

route("POST", /^\/admin\/teams\/(\d+)$/, true, async (req, res, user, m) => {
  if (!isBranchHead(user)) return send(res, 403, { error: "총관리자·지점장만" });
  const b = await readJson(req);
  if (!b.name) return send(res, 400, { error: "팀 이름이 없습니다" });
  db.prepare("UPDATE teams SET name = ? WHERE id = ?").run(b.name, Number(m[1]));
  send(res, 200, { ok: true });
});

// 삭제는 소속 인원이 없을 때만 — 팀을 지워 자료가 미아가 되는 일을 막는다
route("DELETE", /^\/admin\/teams\/(\d+)$/, true, (req, res, user, m) => {
  if (!isBranchHead(user)) return send(res, 403, { error: "총관리자·지점장만" });
  const id = Number(m[1]);
  const cnt = db.prepare("SELECT COUNT(*) n FROM members WHERE team_id = ?").get(id).n;
  if (cnt) return send(res, 400, { error: "소속 인원 " + cnt + "명을 먼저 옮겨야 합니다" });
  db.prepare("DELETE FROM teams WHERE id = ?").run(id);
  send(res, 200, { ok: true });
});

// 내 정보 — 본인이 실명을 확인한다.
// 구글 계정 이름이 그대로 들어오면 "kim jia"처럼 남아서 조직도·업적·일정이 전부 그 이름이 된다.
// 팀·직급은 여기서 바꾸지 못한다 — 직급이 관리자 권한의 근거라 본인이 올리면 권한 상승이다.
route("POST", /^\/me$/, false, async (req, res, user) => {
  const b = await readJson(req);
  const name = String(b.name || "").trim();
  if (name.length < 2 || name.length > 20) return send(res, 400, { error: "이름을 2~20자로 입력해 주세요" });
  const phone = String(b.phone || "").trim().replace(/[^0-9\-]/g, "");
  if (phone && !/^0\d{1,2}-?\d{3,4}-?\d{4}$/.test(phone)) return send(res, 400, { error: "휴대폰 번호 형식을 확인해 주세요" });
  // 생일은 MM-DD만 — 연도를 받으면 나이가 지점 전체에 공개된다
  const birthday = String(b.birthday || "").trim();
  if (birthday && !/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(birthday))
    return send(res, 400, { error: "생일은 08-15 형식으로 넣어 주세요" });
  const joinedAt = String(b.joinedAt || "").trim();
  if (joinedAt && !isDate(joinedAt)) return send(res, 400, { error: "위촉일은 2026-08-01 형식으로 넣어 주세요" });
  db.prepare("UPDATE members SET name = ?, phone = ?, birthday = ?, joined_at = ?, profile_done = 1 WHERE email = ?")
    .run(name, phone, birthday, joinedAt, user.email);
  send(res, 200, { ok: true });
});

route("GET", /^\/me$/, false, (req, res, user) => {
  const m = getMember(db, user.email) || {};
  send(res, 200, {
    name: m.name || user.name, phone: m.phone || "", birthday: m.birthday || "", joinedAt: m.joined_at || "",
    done: !!m.profile_done, role: m.role || "", teamId: m.team_id ?? null
  });
});

route("POST", /^\/admin\/members$/, true, async (req, res, user) => {
  const b = await readJson(req);
  if (!b.email) return send(res, 400, { error: "이메일이 없습니다" });
  const email = String(b.email).toLowerCase();
  // 관리자 임명(is_manager)·전체열람(can_view_all)은 총관리자만
  if ((b.isManager != null || b.canViewAll != null) && !user.isSuper)
    return send(res, 403, { error: "총관리자만" });
  // 자기 열람 범위 밖 구성원은 손대지 못한다 (다른 팀 사람을 빼오거나 지우는 것 차단)
  if (!canManageMember(user, email)) return send(res, 403, { error: "다른 팀 구성원입니다" });
  const prev = getMember(db, email) || {};
  // 없는 직급은 총관리자라도 못 넣는다 — 목록 밖 값이 들어오면 순서 비교가 무너지고,
  // 그 직급을 가진 사람은 아무 직급도 못 주게 된다 (코덱스 검증 2026-08-05).
  if (b.role !== undefined && b.role && !ROLE_ORDER.includes(b.role))
    return send(res, 400, { error: "없는 직급입니다: " + b.role });
  // 직급이 곧 권한이다(GRADE_OF_ROLE). 관리자가 자기 직급을 올리면 스스로 지점장이 된다.
  // 자기 직급은 총관리자만 바꾼다. 남에게도 자기보다 높은 직급은 주지 못한다.
  if (b.role !== undefined && b.role !== (prev.role || "팀원") && !user.isSuper) {
    if (email === user.email) return send(res, 403, { error: "자기 직급은 총관리자만 바꿉니다" });
    if (!canAssignRole(user, b.role))
      return send(res, 403, { error: "자기보다 높은 직급은 줄 수 없습니다" });
  }
  // 보낸 값만 갱신 — 도입자만 바꾸려다 이름·팀·직급이 초기화되는 일이 없도록
  const teamId = b.teamId !== undefined ? (b.teamId ?? null) : (prev.team_id ?? null);
  if (!canWriteTeam(user, teamId)) return send(res, 403, { error: "권한 없는 팀입니다" });
  // 도입자 고리 방지 — 화면(isBelow)에만 두면 API를 직접 부르는 순간 뚫린다.
  // 자기 자신이나 자기 아래 사람을 도입자로 삼으면 그 줄기가 통째로 사라진다.
  if (b.recruiterEmail !== undefined && b.recruiterEmail) {
    const up = String(b.recruiterEmail).toLowerCase();
    if (up === email) return send(res, 400, { error: "자기 자신을 도입자로 둘 수 없습니다" });
    if (!getMember(db, up)) return send(res, 404, { error: "도입자가 명단에 없습니다" });
    let cur = up, guard = 0;
    while (cur && guard++ < 100) {
      if (cur === email) return send(res, 400, { error: "자기 아래 사람을 도입자로 둘 수 없습니다" });
      const m2 = getMember(db, cur);
      cur = m2 ? m2.recruiter_email : null;
    }
  }
  // 위촉 년월 — 차월을 여기서 센다. 「내 정보」에만 두면 실제로 일하지 않는 사람은
  // 로그인을 안 해서 영영 비어 있다. 그래서 관리자가 조직도에서 직접 넣는다(2026-08-04 사용자).
  let joined = b.joinedAt !== undefined ? String(b.joinedAt).trim() : undefined;
  if (joined !== undefined && joined) {
    if (/^\d{4}-\d{2}$/.test(joined)) joined += "-01";      // 년월만 받아도 된다
    if (!isDate(joined)) return send(res, 400, { error: "위촉 년월은 2026-08 형식으로 넣어 주세요" });
  }
  db.prepare(
    `INSERT INTO members (email, name, team_id, role, is_manager, can_view_all, recruiter_email, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       name = excluded.name, team_id = excluded.team_id, role = excluded.role,
       is_manager = excluded.is_manager, can_view_all = excluded.can_view_all,
       recruiter_email = excluded.recruiter_email, joined_at = excluded.joined_at`
  ).run(
    email,
    b.name !== undefined ? b.name : (prev.name || ""),
    teamId,
    b.role !== undefined ? b.role : (prev.role || "팀원"),
    b.isManager != null ? (b.isManager ? 1 : 0) : (prev.is_manager || 0),
    b.canViewAll != null ? (b.canViewAll ? 1 : 0) : (prev.can_view_all || 0),
    b.recruiterEmail !== undefined
      ? (b.recruiterEmail ? String(b.recruiterEmail).toLowerCase() : null)
      : (prev.recruiter_email ?? null),
    joined !== undefined ? joined : (prev.joined_at || "")
  );
  send(res, 200, { ok: true });
});

// 조직도 자리에 계정 붙이기 — 「미연결」 자리를 실제 로그인 계정으로 만든다.
// 초대·승인은 새로 들어오는 사람의 길이고, 이건 이미 계정이 있는 사람의 길이다
// (총관리자 본인처럼 명단 자리와 계정이 따로 노는 경우).
route("POST", /^\/admin\/members\/link$/, true, async (req, res, user) => {
  const b = await readJson(req);
  const seatEmail = String(b.seatEmail || "").toLowerCase();
  const accEmail = String(b.accountEmail || "").toLowerCase();
  if (!seatEmail || !accEmail) return send(res, 400, { error: "자리와 계정이 필요합니다" });
  const seat = getMember(db, seatEmail);
  if (!seat) return send(res, 404, { error: "자리가 없습니다" });
  if (!seat.email.includes("@미등록.local")) return send(res, 400, { error: "이미 계정이 붙은 자리입니다" });
  if (!canWriteTeam(user, seat.team_id)) return send(res, 403, { error: "권한 없는 팀입니다" });
  // 계정은 실제로 존재해야 한다 — 없는 주소를 붙이면 아무도 못 들어오는 유령 자리가 된다
  const acc = authDb.prepare("SELECT email, name FROM accounts WHERE lower(email) = ?").get(accEmail);
  if (!acc) return send(res, 404, { error: "그 계정으로 로그인한 적이 없습니다" });
  // 이미 다른 팀에 있는 계정을 끌어오지 못하게 — 연결은 빈 자리를 채우는 일이지
  // 남의 팀 사람을 데려오는 일이 아니다
  const already = getMember(db, accEmail);
  if (already && !canWriteTeam(user, already.team_id))
    return send(res, 403, { error: "이미 다른 팀에 있는 계정입니다" });
  // 자리의 직급이 그대로 계정에 옮겨간다 — 줄 수 있는 직급인지 봐야 한다.
  // 안 보면 자기 팀에 「지점장」 자리를 만들어 두고 거기에 자기 계정을 붙이면 된다
  // (코덱스 검증 2026-08-05).
  if (!canAssignRole(user, seat.role))
    return send(res, 403, { error: "그 자리의 직급을 줄 권한이 없습니다" });
  // 자리의 팀·직급·도입자를 그대로 계정에 옮긴다. 통째로 되거나 통째로 안 되거나다.
  const upsert = db.prepare(
    `INSERT INTO members (email, name, team_id, role, recruiter_email, sort_order) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET name = excluded.name, team_id = excluded.team_id,
       role = excluded.role, recruiter_email = excluded.recruiter_email, sort_order = excluded.sort_order`
  );
  tx(() => {
    upsert.run(accEmail, seat.name, seat.team_id, seat.role, seat.recruiter_email, seat.sort_order);
    mergeMember(seat.email, accEmail);        // 기록을 옮기고 빈 자리는 지운다
    db.prepare("DELETE FROM pending WHERE email = ?").run(accEmail);
  });
  send(res, 200, { ok: true });
});

// 자리에 붙일 수 있는 계정 목록.
// 「승인 대기자」만 후보로 두면, 로그인은 했는데 가입 신청을 안 한 사람은
// 영영 못 붙인다 (2026-08-05 사용자: 「연결이 안되는데」).
route("GET", /^\/admin\/accounts$/, true, (req, res, user) => {
  const seats = {};
  db.prepare("SELECT email, name FROM members").all().forEach(m => { seats[m.email] = m.name; });
  const pending = {};
  db.prepare("SELECT email FROM pending").all().forEach(p => { pending[p.email] = true; });
  const list = listAccounts(authDb).map(a => ({
    email: a.email,
    name: a.name || a.email,
    // 이미 하랑지점 명단에 있는 계정도 후보로 둔다 — 자리와 계정이 두 줄로 갈린
    // 사람을 합치는 길이다. 어느 쪽인지 화면이 알 수 있게 표시를 붙여 보낸다.
    state: seats[a.email] !== undefined ? "명단" : pending[a.email] ? "대기" : "미신청"
  }));
  send(res, 200, list);
});

// 조직도 순서 — 끌어서 놓은 결과를 그대로 저장한다. 팀 하나 단위로 받는다.
route("POST", /^\/admin\/members\/order$/, true, async (req, res, user) => {
  const b = await readJson(req);
  const teamId = b.teamId ?? null;
  if (!Array.isArray(b.emails)) return send(res, 400, { error: "순서가 없습니다" });
  if (!canWriteTeam(user, teamId)) return send(res, 403, { error: "권한 없는 팀입니다" });
  const targets = b.emails.map(em => getMember(db, String(em).toLowerCase()));
  // 하나라도 손댈 수 없는 사람이 섞여 있으면 아예 하지 않는다 —
  // 일부만 바뀐 채 성공으로 돌아가면 순서가 어긋난 것을 아무도 모른다
  if (targets.some(t => !t)) return send(res, 404, { error: "명단에 없는 사람이 있습니다" });
  if (targets.some(t => !canWriteTeam(user, t.team_id))) return send(res, 403, { error: "권한 없는 팀이 섞여 있습니다" });
  const up = db.prepare("UPDATE members SET sort_order = ?, team_id = ? WHERE email = ?");
  tx(() => targets.forEach((t, i) => up.run(i, teamId, t.email)));
  send(res, 200, { ok: true });
});

// 명단에서 내리기 — 지우지 않는다.
// 지우면 그 사람의 일정·TA 일지·업적이 주인 없는 기록으로 남고, 팀 합계도 어긋난다.
// 기록이 하나도 없는 자리(잘못 만든 줄)만 실제로 지운다.
route("DELETE", /^\/admin\/members\/([^/]+)$/, true, (req, res, user, m) => {
  const email = decodeURIComponent(m[1]).toLowerCase();
  if (!canManageMember(user, email)) return send(res, 403, { error: "다른 팀 구성원입니다" });
  const has = ["SELECT COUNT(*) n FROM events WHERE member_email = ?",
               "SELECT COUNT(*) n FROM ta_logs WHERE author_email = ?",
               "SELECT COUNT(*) n FROM perf WHERE member_email = ?",
               "SELECT COUNT(*) n FROM perf_goals WHERE member_email = ?",
               "SELECT COUNT(*) n FROM attendance WHERE email = ?",
               "SELECT COUNT(*) n FROM task_done WHERE email = ?",
               "SELECT COUNT(*) n FROM tasks WHERE targets LIKE '%' || ? || '%'",
               "SELECT COUNT(*) n FROM events WHERE detail LIKE '%' || ? || '%'",
               "SELECT COUNT(*) n FROM docs WHERE owner_email = ?",
               "SELECT COUNT(*) n FROM trainings WHERE member_email = ?"]
    .some(sql => db.prepare(sql).get(email).n > 0);
  // 아래 사람들은 한 칸 위(그 사람의 도입자)로 올려붙인다 — 줄기가 끊기지 않게
  const gone = getMember(db, email);
  const up = gone && gone.recruiter_email && gone.recruiter_email !== email ? gone.recruiter_email : null;
  const lift = () => db.prepare("UPDATE members SET recruiter_email = ? WHERE recruiter_email = ?").run(up, email);
  if (!has) {
    tx(() => { lift(); db.prepare("DELETE FROM members WHERE email = ?").run(email); });
    return send(res, 200, { ok: true, removed: true });
  }
  tx(() => {
    lift();
    db.prepare("UPDATE members SET active = 0, left_at = ?, is_manager = 0, can_view_all = 0 WHERE email = ?")
      .run(today(), email);
  });
  send(res, 200, { ok: true, removed: false });
});

// 다시 올리기 — 잘못 내렸거나 복귀한 경우
route("POST", /^\/admin\/members\/([^/]+)\/restore$/, true, (req, res, user, m) => {
  const email = decodeURIComponent(m[1]).toLowerCase();
  if (!canManageMember(user, email)) return send(res, 403, { error: "다른 팀 구성원입니다" });
  db.prepare("UPDATE members SET active = 1, left_at = '' WHERE email = ?").run(email);
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
    try {
      if (file.startsWith(normalize(WEB_DIR)) && existsSync(file) && extname(file)) {
        const types = {
          ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
          ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
          ".webmanifest": "application/manifest+json", ".json": "application/json"
        };
        const ct = types[extname(file)] || "application/octet-stream";
        const binary = /^(image|font)\//.test(ct) || ct === "application/octet-stream";
        // 화면·설정 파일은 매번 서버에 물어본다. 안 그러면 배포해도 옛 화면이 그대로 남는다
        // (부지점장 화면만 옛 구분이 보이던 사고 — 2026-08-03).
        // 그림·영상은 잘 바뀌지 않으니 하루 정도 들고 있게 둔다.
        const fresh = [".html", ".css", ".js", ".webmanifest", ".json"].includes(extname(file));
        res.writeHead(200, {
          "Content-Type": ct + (binary ? "" : "; charset=utf-8"),
          "Cache-Control": fresh ? "no-cache" : "public, max-age=86400"
        });
        return res.end(readFileSync(file));
      }
      if (path === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        return res.end(readFileSync(normalize(join(WEB_DIR, "index.html"))));
      }
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("파일을 찾을 수 없습니다");
    }
  }

  const user = userFor(req);
  if (!user) return send(res, 401, { error: "로그인이 필요합니다" });

  // 명단 미등록 계정에 열어두는 유일한 경로 — 가입 신청·상태 확인.
  // (초대 링크로 들어온 사람이 여기서 줄을 서고, 승인권자가 승인하면 열린다)
  if (user.unlisted) {
    if (path === "/join" && req.method === "POST") {
      const b = await readJson(req).catch(() => ({}));
      const inv = b.code
        ? db.prepare("SELECT * FROM invites WHERE code = ? AND expires_at > ?").get(String(b.code), now())
        : null;
      db.prepare(
        `INSERT INTO pending (email, name, team_id, role, invite_code, by_name, created)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET name = excluded.name, team_id = excluded.team_id,
           role = excluded.role, invite_code = excluded.invite_code, by_name = excluded.by_name`
      ).run(user.email, b.name || user.name || "", inv ? inv.team_id : null,
            inv ? inv.role : "팀원", inv ? inv.code : null, inv ? inv.by_name : "", now());
      return send(res, 200, { ok: true, invited: !!inv });
    }
    if (path === "/join" && req.method === "GET") {
      const p = db.prepare("SELECT * FROM pending WHERE email = ?").get(user.email);
      return send(res, 200, { status: p ? "대기" : "없음", name: user.name, email: user.email });
    }
    return send(res, 403, {
      error: "승인 대기 중입니다. 승인되면 바로 이용할 수 있습니다.", needJoin: true
    });
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.pattern.exec(path);
    if (!m) continue;
    if (r.needManager && !user.isManager) return send(res, 403, { error: "관리자만" });
    try { return await r.handler(req, res, user, m); }
    catch (e) {
      // 로그가 없으면 장애 원인을 알 수 없다 (journalctl -u ourbranch 로 확인)
      console.error("[" + req.method + " " + path + "]", e && e.message, e && e.stack);
      return send(res, 500, { error: "서버 오류" });
    }
  }
  send(res, 404, { error: "없는 경로" });
});

server.listen(PORT, () => console.log("ourbranch API :" + PORT));

// 보관기간 청소 — 켤 때 한 번, 이후 하루 한 번
purgeOldTa();
setInterval(purgeOldTa, 24 * 3600e3).unref();

// 주인 없는 서류 파일 청소 — 같은 주기
purgeOrphanFiles();
setInterval(purgeOrphanFiles, 24 * 3600e3).unref();
