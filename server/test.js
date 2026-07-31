// 자가 테스트 — 권한 경계(팀 분리·관리자·총관리자)가 서버에서 실제로 막히는지 확인한다.
// 실행: node test.js  (외부 패키지 없음, 임시 DB 생성 후 삭제)

import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { spawn } from "node:child_process";
import assert from "node:assert";

const AUTH = "./test-auth.db", DATA = "./test-data.db", PORT = 18788;
const BASE = "http://127.0.0.1:" + PORT;

for (const f of [AUTH, DATA]) rmSync(f, { force: true });
rmSync(DATA + "-wal", { force: true }); rmSync(DATA + "-shm", { force: true });

// 마이가디언 DB 흉내 — accounts·sessions만 있으면 된다
const auth = new DatabaseSync(AUTH);
auth.exec(`
  CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT, name TEXT, status TEXT, grade TEXT, is_admin INTEGER);
  CREATE TABLE sessions (token TEXT PRIMARY KEY, account_id INTEGER, expires_at TEXT);
`);
const far = new Date(Date.now() + 86400e3).toISOString();
const seed = auth.prepare("INSERT INTO accounts (id, email, name, status, grade, is_admin) VALUES (?, ?, ?, ?, ?, ?)");
seed.run(1, "super@x.com", "안창민", "승인", "SSL", 1);   // 총관리자
seed.run(2, "esl1@x.com", "부지점장1", "승인", "ESL", 0);  // 1팀 관리자
seed.run(3, "fc1@x.com", "팀원1", "승인", "FC", 0);        // 1팀
seed.run(4, "fc2@x.com", "팀원2", "승인", "FC", 0);        // 2팀
seed.run(5, "wait@x.com", "대기자", "대기", null, 0);
const tok = auth.prepare("INSERT INTO sessions (token, account_id, expires_at) VALUES (?, ?, ?)");
tok.run("t-super", 1, far); tok.run("t-esl1", 2, far); tok.run("t-fc1", 3, far);
tok.run("t-fc2", 4, far); tok.run("t-wait", 5, far);
auth.close();

const srv = spawn(process.execPath, ["server.js"], {
  env: { ...process.env, PORT: String(PORT), DB_FILE: DATA, AUTH_DB_FILE: AUTH },
  stdio: "inherit"
});

const api = (token, method, path, body) =>
  fetch(BASE + path, {
    method: method || "GET",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });

async function main() {
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + "/health"); break; } catch { await new Promise(r => setTimeout(r, 100)); }
  }

  // 1) 인증 경계: 토큰 없음 401, 미승인 계정 401
  assert.equal((await fetch(BASE + "/bootstrap")).status, 401);
  assert.equal((await api("t-wait", "GET", "/bootstrap")).status, 401);

  // 2) 총관리자: 팀 2개 생성, 구성원 배치 (관리자 임명 포함)
  assert.equal((await api("t-super", "POST", "/admin/teams", { name: "1팀" })).status, 200);
  assert.equal((await api("t-super", "POST", "/admin/teams", { name: "2팀" })).status, 200);
  for (const m of [
    { email: "esl1@x.com", name: "부지점장1", teamId: 1, role: "부지점장" },
    { email: "fc1@x.com", name: "팀원1", teamId: 1 },
    { email: "fc2@x.com", name: "팀원2", teamId: 2 }
  ]) assert.equal((await api("t-super", "POST", "/admin/members", m)).status, 200);

  // 3) 열람 분리: 팀원1은 1팀만, 총관리자는 전체
  let b = await (await api("t-fc1", "GET", "/bootstrap")).json();
  assert.deepEqual(b.teams.map(t => t.name), ["1팀"]);
  assert.deepEqual(b.members.map(m => m.email).sort(), ["esl1@x.com", "fc1@x.com"]);
  b = await (await api("t-super", "GET", "/bootstrap")).json();
  assert.equal(b.teams.length, 2);

  // 4) 공지: 팀원은 작성 불가(403), 부지점장은 자기 팀 공지, 총관리자는 지점 공통
  assert.equal((await api("t-fc1", "POST", "/notices", { title: "x" })).status, 403);
  assert.equal((await api("t-esl1", "POST", "/notices", { title: "1팀 공지", teamId: 1 })).status, 200);
  assert.equal((await api("t-esl1", "POST", "/notices", { title: "2팀 침범", teamId: 2 })).status, 403);
  assert.equal((await api("t-super", "POST", "/notices", { title: "지점 공통" })).status, 200);
  const fc2Sees = await (await api("t-fc2", "GET", "/notices")).json();
  assert.deepEqual(fc2Sees.map(n => n.title), ["지점 공통"]);   // 1팀 공지는 안 보임
  const fc1Sees = await (await api("t-fc1", "GET", "/notices")).json();
  assert.equal(fc1Sees.length, 2);

  // 5) 댓글: 열람 가능한 공지에만
  const common = fc1Sees.find(n => n.title === "지점 공통");
  const team1 = fc1Sees.find(n => n.title === "1팀 공지");
  assert.equal((await api("t-fc2", "POST", "/notices/" + common.id + "/comments", { content: "확인" })).status, 200);
  assert.equal((await api("t-fc2", "POST", "/notices/" + team1.id + "/comments", { content: "침범" })).status, 403);

  // 6) 일정: 팀원 개인 일정은 본인만, 팀 공유 일정은 관리자만
  assert.equal((await api("t-fc1", "POST", "/events", { date: "2026-08-01", memberEmail: "fc1@x.com", kind: "상담" })).status, 200);
  assert.equal((await api("t-fc1", "POST", "/events", { date: "2026-08-01", kind: "회의", title: "팀회의" })).status, 403);
  assert.equal((await api("t-esl1", "POST", "/events", { date: "2026-08-01", kind: "회의", title: "팀회의" })).status, 200);
  const ev2 = await (await api("t-fc2", "GET", "/events?from=2026-08-01&to=2026-08-01")).json();
  assert.equal(ev2.length, 0);   // 2팀 팀원에게 1팀 일정 안 보임

  // 6-1) 일정 수정: 본인 것만 (관리자는 팀 것도)
  const evs1 = await (await api("t-fc1", "GET", "/events?from=2026-08-01&to=2026-08-01")).json();
  const mineEv = evs1.find(e => e.member_email === "fc1@x.com");
  assert.equal((await api("t-fc1", "POST", "/events/" + mineEv.id, { start: "10:00", end: "11:00" })).status, 200);
  const teamEv = evs1.find(e => !e.member_email);
  assert.equal((await api("t-fc1", "POST", "/events/" + teamEv.id, { title: "침범" })).status, 403);
  assert.equal((await api("t-esl1", "POST", "/events/" + teamEv.id, { title: "팀회의(변경)" })).status, 200);

  // 6-2) 마이가디언 고객미팅 upsert: 멱등키 갱신, 취소는 상태만
  const meet = { "출처": "myguardian", "출처키": "mg:C-2026-014:3", "종류": "고객미팅", "고객코드": "C-2026-014", "차수": 3, "일시": "2026-08-05T14:00:00+09:00", "상태": "예정" };
  assert.equal((await api("t-fc1", "POST", "/events/upsert", meet)).status, 200);
  assert.equal((await api("t-fc1", "POST", "/events/upsert", { ...meet, "일시": "2026-08-06T15:00:00+09:00" })).status, 200);
  let mEvs = await (await api("t-fc1", "GET", "/events?from=2026-08-01&to=2026-08-10")).json();
  const mine2 = mEvs.filter(e => e.source_key === "mg:C-2026-014:3");
  assert.equal(mine2.length, 1);                       // 멱등 — 한 건으로 유지
  assert.equal(mine2[0].date, "2026-08-06");
  assert.equal(mine2[0].start, "15:00");
  assert.equal(mine2[0].customer_code, "C-2026-014");
  assert.equal((await api("t-fc1", "POST", "/events/upsert", { ...meet, "상태": "취소" })).status, 200);
  mEvs = await (await api("t-fc1", "GET", "/events?from=2026-08-01&to=2026-08-10")).json();
  assert.equal(mEvs.filter(e => e.source_key === "mg:C-2026-014:3")[0].status, "취소");

  // 7) 출근 자가 보고 + upsert
  assert.equal((await api("t-fc1", "POST", "/attendance", { date: "2026-08-01", present: true, aitom: true })).status, 200);
  assert.equal((await api("t-fc1", "POST", "/attendance", { date: "2026-08-01", present: true, aitom: false })).status, 200);
  const att = await (await api("t-esl1", "GET", "/attendance?date=2026-08-01")).json();
  assert.equal(att.length, 1); assert.equal(att[0].aitom, 0);

  // 8) 총관리자 전용: 관리자 임명·전체열람은 부지점장이 못 건드림
  assert.equal((await api("t-esl1", "POST", "/admin/members", { email: "fc1@x.com", isManager: true })).status, 403);
  assert.equal((await api("t-super", "POST", "/admin/members", { email: "esl1@x.com", name: "부지점장1", teamId: 1, role: "부지점장", canViewAll: true })).status, 200);
  const eslSees = await (await api("t-esl1", "GET", "/notices")).json();
  assert.equal(eslSees.length, 2);   // 전체열람 승인 후 지점 공통+1팀 (2팀 공지는 아직 없음)

  // 9) TA 일지: 여러 줄 저장(붙여넣기), 월 조회, 팀 분리, 본인 기록만 삭제
  const taRows = [
    { date: "2026-08-01", cand_name: "홍길동", gender: "남", age: "27", region: "서울", result: "부재" },
    { date: "2026-08-01", cand_name: "김영희", gender: "여", age: "25", region: "경기", result: "CIS 약속 8/5 14시" }
  ];
  const taRes = await (await api("t-fc1", "POST", "/ta", { rows: taRows })).json();
  assert.equal(taRes.ids.length, 2);
  let ta = await (await api("t-fc1", "GET", "/ta?month=2026-08")).json();
  assert.equal(ta.length, 2);
  assert.equal((await api("t-fc2", "GET", "/ta?month=2026-08")).status, 200);
  assert.equal((await (await api("t-fc2", "GET", "/ta?month=2026-08")).json()).length, 0);   // 2팀은 안 보임
  assert.equal((await api("t-fc1", "POST", "/ta/" + taRes.ids[0], { result: "재통화 약속" })).status, 200);
  ta = await (await api("t-fc1", "GET", "/ta?month=2026-08")).json();
  assert.equal(ta[0].result, "재통화 약속");
  assert.equal((await api("t-fc1", "DELETE", "/ta/" + taRes.ids[1])).status, 200);

  // 10) 업적: 월별 저장·조회·합계 재료, 목표는 관리자만
  const pf = await (await api("t-esl1", "POST", "/perf", {
    month: "2026-08",
    rows: [
      { member: "팀원1", contract_date: "2026-08-03", premium: 100000, canp: 120 },
      { member: "팀원1", contract_date: "2026-08-10", premium: 50000, canp: 60 }
    ]
  })).json();
  assert.equal(pf.ids.length, 2);
  assert.equal((await api("t-fc1", "POST", "/perf/goals", { month: "2026-08", goals: [{ member: "팀원1", goal: "1,000(100)" }] })).status, 403);
  assert.equal((await api("t-esl1", "POST", "/perf/goals", { month: "2026-08", goals: [{ member: "팀원1", goal: "1,000(100)" }] })).status, 200);
  const perf = await (await api("t-fc1", "GET", "/perf?month=2026-08")).json();
  assert.equal(perf.rows.length, 2);
  assert.equal(perf.goals[0].goal, "1,000(100)");
  assert.equal((await (await api("t-fc2", "GET", "/perf?month=2026-08")).json()).rows.length, 0);

  // 11) 본인 것만: 팀원이 남 이름으로 일지·업적 입력 불가, 부지점장은 가능
  assert.equal((await api("t-fc1", "POST", "/ta", { rows: [{ date: "2026-08-02", author: "부지점장1" }] })).status, 403);
  assert.equal((await api("t-esl1", "POST", "/ta", { rows: [{ date: "2026-08-02", author: "팀원1" }] })).status, 200);
  assert.equal((await api("t-fc1", "POST", "/perf", { month: "2026-08", rows: [{ member: "다른사람" }] })).status, 403);
  assert.equal((await api("t-fc1", "POST", "/perf", { month: "2026-08", rows: [{ member: "팀원1", contract_date: "2026-08-20", premium: 30000, canp: 40 }] })).status, 200);

  console.log("전체 통과 — 인증·팀 분리·관리자·총관리자·TA일지·업적·본인기록 경계 확인 완료");
}

main().catch(e => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    // 윈도우는 프로세스가 살아 있는 동안 DB 파일을 지울 수 없다 — 종료를 기다린다
    const exited = new Promise(r => srv.on("exit", r));
    srv.kill();
    await exited;
    for (const f of [AUTH, DATA, DATA + "-wal", DATA + "-shm"])
      try { rmSync(f, { force: true }); } catch { /* WAL 잔재는 다음 실행이 지운다 */ }
  });
