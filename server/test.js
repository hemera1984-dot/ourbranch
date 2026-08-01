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
seed.run(6, "new@x.com", "신입", "승인", "FC", 0);          // 승인됐지만 지점 명단엔 없음
seed.run(7, "bm@x.com", "지점장", "승인", "BM", 0);         // 지점장 — 지점 전체 관리
const tok = auth.prepare("INSERT INTO sessions (token, account_id, expires_at) VALUES (?, ?, ?)");
tok.run("t-super", 1, far); tok.run("t-esl1", 2, far); tok.run("t-fc1", 3, far);
tok.run("t-fc2", 4, far); tok.run("t-wait", 5, far); tok.run("t-new", 6, far);
tok.run("t-bm", 7, far);
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
  const mine2 = mEvs.filter(e => e.source_key === "fc1@x.com|mg:C-2026-014:3");
  assert.equal(mine2.length, 1);                       // 멱등 — 한 건으로 유지
  assert.equal(mine2[0].date, "2026-08-06");
  assert.equal(mine2[0].start, "15:00");
  assert.equal(mine2[0].customer_code, "C-2026-014");
  assert.equal((await api("t-fc1", "POST", "/events/upsert", { ...meet, "상태": "취소" })).status, 200);
  mEvs = await (await api("t-fc1", "GET", "/events?from=2026-08-01&to=2026-08-10")).json();
  assert.equal(mEvs.filter(e => e.source_key === "fc1@x.com|mg:C-2026-014:3")[0].status, "취소");

  // 6-3) 장소 왕복 + 도입자 열람 (팀이 달라도 자기가 도입한 팀원의 일정을 본다)
  const pl = await (await api("t-fc1", "POST", "/events", { date: "2026-08-03", memberEmail: "fc1@x.com", kind: "상담", title: "고객 상담", place: "강남 스타벅스" })).json();
  const plEv = (await (await api("t-fc1", "GET", "/events?from=2026-08-03&to=2026-08-03")).json()).find(e => e.id === pl.id);
  assert.equal(plEv.place, "강남 스타벅스");
  // fc2(2팀)를 fc1(1팀)의 도입 팀원으로 지정
  assert.equal((await api("t-super", "POST", "/admin/members", { email: "fc2@x.com", name: "팀원2", teamId: 2, role: "팀원", recruiterEmail: "fc1@x.com" })).status, 200);
  assert.equal((await api("t-fc2", "POST", "/events", { date: "2026-08-04", memberEmail: "fc2@x.com", kind: "교육", title: "신인 교육" })).status, 200);
  const recEvs = await (await api("t-fc1", "GET", "/events?from=2026-08-04&to=2026-08-04")).json();
  assert.equal(recEvs.filter(e => e.member_email === "fc2@x.com").length, 1);   // 도입자는 보인다
  const fc2boot = await (await api("t-fc1", "GET", "/bootstrap")).json();
  assert.ok(fc2boot.members.some(m => m.email === "fc2@x.com"));               // 명단에도 나타난다
  const otherView = await (await api("t-esl1", "GET", "/events?from=2026-08-04&to=2026-08-04")).json();
  assert.equal(otherView.filter(e => e.member_email === "fc2@x.com").length, 0); // 도입자 아닌 1팀 부지점장에겐 안 보인다

  // 6-4) 강의: 누구나 등록(지점 전체), 다른 팀도 신청 가능, 토글
  const lec = await (await api("t-fc1", "POST", "/events", { date: "2026-08-07", memberEmail: "fc1@x.com", kind: "강의", title: "화법 강의", place: "회의실" })).json();
  const lecSeen = await (await api("t-fc2", "GET", "/events?from=2026-08-07&to=2026-08-07")).json();
  assert.equal(lecSeen.filter(e => e.id === lec.id).length, 1);          // 2팀 팀원에게도 보임
  assert.deepEqual(await (await api("t-fc2", "POST", "/events/" + lec.id + "/attend")).json(), { attending: true });
  const lecAfter = (await (await api("t-fc1", "GET", "/events?from=2026-08-07&to=2026-08-07")).json()).find(e => e.id === lec.id);
  assert.equal(lecAfter.attendees.length, 1);
  assert.equal(lecAfter.attendees[0].name, "팀원2");
  assert.deepEqual(await (await api("t-fc2", "POST", "/events/" + lec.id + "/attend")).json(), { attending: false });

  // 7) 출석 체크 + 부분 갱신 (점심만 고쳐도 출석·체크시각 유지)
  assert.equal((await api("t-fc1", "POST", "/attendance", { date: "2026-08-01", present: true, aitom: true })).status, 200);
  let att = await (await api("t-esl1", "GET", "/attendance?date=2026-08-01")).json();
  const checkedAt = att[0].checked_at;
  assert.ok(checkedAt);
  assert.equal((await api("t-fc1", "POST", "/attendance", { date: "2026-08-01", work: "10시 출근", lunch: "동반 점심", aitom: false })).status, 200);
  att = await (await api("t-esl1", "GET", "/attendance?date=2026-08-01")).json();
  assert.equal(att.length, 1); assert.equal(att[0].aitom, 0);
  assert.equal(att[0].present, 1);                       // 출석 유지
  assert.equal(att[0].checked_at, checkedAt);            // 체크 시각 유지
  assert.equal(att[0].lunch, "동반 점심");
  // 일일보고 항목(오전·점심·오후·특이사항) 왕복 + 부분 갱신 유지
  assert.equal((await api("t-fc1", "POST", "/attendance", { date: "2026-08-01", afternoon: "저녁 약속", note: "도입 노력하겠습니다" })).status, 200);
  att = await (await api("t-fc1", "GET", "/attendance?date=2026-08-01")).json();
  assert.equal(att[0].afternoon, "저녁 약속");
  assert.equal(att[0].note, "도입 노력하겠습니다");
  assert.equal(att[0].lunch, "동반 점심");            // 앞서 넣은 값 유지
  assert.equal(att[0].present, 1);

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

  // 10-1) 미션: 대상 본인만 상태 변경, 삭제는 관리자만
  const t1 = await (await api("t-esl1", "POST", "/tasks", { title: "개인 미션", targets: ["fc1@x.com"], due: "2026-08-10" })).json();
  const t2 = await (await api("t-esl1", "POST", "/tasks", { title: "팀 미션", targets: "전체" })).json();
  assert.equal((await api("t-fc1", "POST", "/tasks/" + t1.id + "/status", { status: "진행중" })).status, 200);
  assert.equal((await api("t-fc1", "POST", "/tasks/" + t2.id + "/status", { status: "진행중" })).status, 200);
  // fc1이 아닌 대상의 미션: 만들어서 fc1이 못 바꾸는지 — esl 대상 미션
  const t3 = await (await api("t-super", "POST", "/tasks", { teamId: 1, title: "부지점장 개인 미션", targets: ["esl1@x.com"] })).json();
  assert.equal((await api("t-fc1", "POST", "/tasks/" + t3.id + "/status", { status: "완료" })).status, 403);
  assert.equal((await api("t-fc1", "DELETE", "/tasks/" + t1.id)).status, 403);
  assert.equal((await api("t-esl1", "DELETE", "/tasks/" + t1.id)).status, 200);

  // 10-2) 공지 확인 버튼: 토글, 집계. 미션 달성 체크: 대상만, 토글
  const nList = await (await api("t-fc1", "GET", "/notices")).json();
  const nid = nList[0].id;
  assert.deepEqual(await (await api("t-fc1", "POST", "/notices/" + nid + "/read")).json(), { read: true });
  let n1 = (await (await api("t-fc1", "GET", "/notices")).json()).find(x => x.id === nid);
  assert.equal(n1.reads.length, 1);
  assert.deepEqual(await (await api("t-fc1", "POST", "/notices/" + nid + "/read")).json(), { read: false });

  const tDone = await (await api("t-esl1", "POST", "/tasks", { title: "달성 테스트", targets: "전체" })).json();
  assert.equal((await api("t-fc1", "POST", "/tasks/" + tDone.id + "/done", {})).status, 200);
  const td = (await (await api("t-fc1", "GET", "/tasks")).json()).find(x => x.id === tDone.id);
  assert.equal(td.dones.length, 1);
  const tSolo = await (await api("t-esl1", "POST", "/tasks", { title: "개인 달성", targets: ["esl1@x.com"] })).json();
  assert.equal((await api("t-fc1", "POST", "/tasks/" + tSolo.id + "/done", {})).status, 403);   // 대상 아님

  // 10-3) 업적 목표 + 도입 실적
  assert.equal((await api("t-esl1", "POST", "/perf/goals", { month: "2026-08", goals: [{ member: "팀원1", goal: "1,000(100)", intro: 4 }] })).status, 200);
  const pg = await (await api("t-fc1", "GET", "/perf?month=2026-08")).json();
  assert.equal(pg.goals.find(g => g.member === "팀원1").intro, 4);

  // 11) 본인 것만: 팀원이 남 이름으로 일지·업적 입력 불가, 부지점장은 가능
  assert.equal((await api("t-fc1", "POST", "/ta", { rows: [{ date: "2026-08-02", author: "부지점장1" }] })).status, 403);
  assert.equal((await api("t-esl1", "POST", "/ta", { rows: [{ date: "2026-08-02", author: "팀원1" }] })).status, 200);
  assert.equal((await api("t-fc1", "POST", "/perf", { month: "2026-08", rows: [{ member: "다른사람" }] })).status, 403);
  assert.equal((await api("t-fc1", "POST", "/perf", { month: "2026-08", rows: [{ member: "팀원1", contract_date: "2026-08-20", premium: 30000, canp: 40 }] })).status, 200);

  // 12) 검증(Codex·자체)에서 나온 우회 경로 회귀 테스트
  // 12-1) 전체열람(can_view_all)은 열람 권한일 뿐 — 다른 팀에 쓰지 못한다
  assert.equal((await api("t-esl1", "POST", "/notices", { title: "2팀 침범", teamId: 2 })).status, 403);
  assert.equal((await api("t-esl1", "POST", "/tasks", { title: "2팀 미션", teamId: 2 })).status, 403);
  assert.equal((await api("t-esl1", "POST", "/perf", { month: "2026-08", teamId: 2, rows: [{ member: "팀원2" }] })).status, 403);
  // 열람은 여전히 된다
  assert.ok((await (await api("t-esl1", "GET", "/notices")).json()).length > 0);

  // 12-2) 지점 공통(팀 없음) 공지는 총관리자만 쓰고 지운다
  assert.equal((await api("t-esl1", "POST", "/notices", { title: "지점 공통 사칭" })).status, 403);
  const common2 = (await (await api("t-super", "GET", "/notices")).json()).find(n => n.team_id == null);
  assert.equal((await api("t-esl1", "DELETE", "/notices/" + common2.id)).status, 403);

  // 12-3) 관리자도 다른 팀 구성원을 옮기거나 지우지 못한다 (자기 팀 이동으로 권한 우회 차단)
  assert.equal((await api("t-esl1", "POST", "/admin/members", { email: "esl1@x.com", teamId: 2 })).status, 403);
  assert.equal((await api("t-esl1", "DELETE", "/admin/members/" + encodeURIComponent("fc2@x.com"))).status, 403);
  // 팀 신설은 총관리자만
  assert.equal((await api("t-esl1", "POST", "/admin/teams", { name: "몰래 만든 팀" })).status, 403);

  // 12-4) 구성원 부분 갱신 — 도입자만 바꿔도 이름·팀·직급이 남는다
  assert.equal((await api("t-super", "POST", "/admin/members", { email: "fc1@x.com", recruiterEmail: "esl1@x.com" })).status, 200);
  const boot3 = await (await api("t-super", "GET", "/bootstrap")).json();
  const fc1row = boot3.members.find(m => m.email === "fc1@x.com");
  assert.equal(fc1row.name, "팀원1"); assert.equal(fc1row.team_id, 1); assert.equal(fc1row.role, "팀원");

  // 12-5) 일정 대상 바꿔치기 차단 (팀 공유·남의 달력에 심기)
  const ev = await (await api("t-fc1", "POST", "/events", { date: "2026-08-09", memberEmail: "fc1@x.com", kind: "상담" })).json();
  assert.equal((await api("t-fc1", "POST", "/events/" + ev.id, { memberEmail: null })).status, 403);
  assert.equal((await api("t-fc1", "POST", "/events/" + ev.id, { memberEmail: "esl1@x.com" })).status, 403);

  // 12-6) 마이가디언 멱등키는 계정별 — 남의 일정을 덮어쓰지 못한다
  const key = { "출처": "myguardian", "출처키": "mg:C-2026-014:3", "고객코드": "C-2026-014", "일시": "2026-08-11T10:00:00+09:00" };
  await api("t-fc1", "POST", "/events/upsert", key);
  await api("t-fc2", "POST", "/events/upsert", { ...key, "고객코드": "덮어쓰기시도", "일시": "2027-01-01T09:00:00+09:00", "상태": "취소" });
  const fc1Ev = (await (await api("t-fc1", "GET", "/events?from=2026-08-11&to=2026-08-11")).json())
    .find(e => e.source === "myguardian" && e.member_email === "fc1@x.com");
  assert.ok(fc1Ev); assert.equal(fc1Ev.customer_code, "C-2026-014"); assert.equal(fc1Ev.status, "예정");

  // 12-7) TA 담당자 위조 차단 (수정 경로)
  const taOwn = await (await api("t-fc1", "POST", "/ta", { rows: [{ date: "2026-08-12", cand_name: "테스트" }] })).json();
  assert.equal((await api("t-fc1", "POST", "/ta/" + taOwn.ids[0], { author: "부지점장1" })).status, 403);

  // 12-8) 목표 부분 저장 — 목표만 고쳐도 도입 실적이 남는다
  await api("t-esl1", "POST", "/perf/goals", { month: "2026-09", goals: [{ member: "팀원1", goal: "1,000(100)", intro: 4 }] });
  await api("t-esl1", "POST", "/perf/goals", { month: "2026-09", goals: [{ member: "팀원1", goal: "1,200(120)" }] });
  const g9 = (await (await api("t-fc1", "GET", "/perf?month=2026-09")).json()).goals.find(g => g.member === "팀원1");
  assert.equal(g9.goal, "1,200(120)"); assert.equal(g9.intro, 4);

  // 12-9) 쉼표 금액이 0이 되지 않는다
  await api("t-fc1", "POST", "/perf", { month: "2026-09", rows: [{ member: "팀원1", contract_date: "2026-09-02", premium: "1,000,000", canp: "1,200" }] });
  const p9 = (await (await api("t-fc1", "GET", "/perf?month=2026-09")).json()).rows.find(r => r.contract_date === "2026-09-02");
  assert.equal(p9.premium, 1000000); assert.equal(p9.canp, 1200);

  // 12-10) TA 월 조회에 와일드카드가 통하지 않는다
  const wild = await (await api("t-fc1", "GET", "/ta?month=%25")).json();
  const aug = await (await api("t-fc1", "GET", "/ta?month=2026-08")).json();
  assert.equal(wild.length, aug.length);   // %는 무시되고 이번 달 기본값으로 처리

  // 13) 초대 → 가입 신청 → 승인
  // 13-1) 명단 미등록 계정은 자료를 못 보고 가입 신청만 가능
  const blocked = await api("t-new", "GET", "/bootstrap");
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).needJoin, true);
  assert.equal((await api("t-new", "GET", "/notices")).status, 403);

  // 13-2) 초대는 팀원 누구나 만든다
  const inv = await (await api("t-fc1", "POST", "/invites", { role: "팀원" })).json();
  assert.ok(inv.code && inv.code.length >= 8);
  assert.equal(inv.teamName, "1팀");

  // 13-3) 초대 코드로 신청하면 초대한 팀·직급이 따라붙는다
  assert.equal((await api("t-new", "POST", "/join", { code: inv.code, name: "신입" })).status, 200);
  let bootA = await (await api("t-esl1", "GET", "/bootstrap")).json();
  const pend = bootA.pending.find(p => p.email === "new@x.com");
  assert.ok(pend); assert.equal(pend.team_id, 1); assert.equal(pend.by_name, "팀원1");
  // 승인권자가 아닌 계정에는 대기 목록이 비어 있다
  const bootFc = await (await api("t-fc1", "GET", "/bootstrap")).json();
  assert.equal(bootFc.pending.length, 0);
  assert.equal(bootFc.me.canApprove, false);
  assert.equal((await api("t-fc1", "POST", "/pending/approve", { email: "new@x.com" })).status, 403);

  // 13-4) 부지점장이 승인하면 바로 열린다
  assert.equal((await api("t-esl1", "POST", "/pending/approve", { email: "new@x.com", teamId: 1 })).status, 200);
  assert.equal((await api("t-new", "GET", "/bootstrap")).status, 200);
  const bootNew = await (await api("t-new", "GET", "/bootstrap")).json();
  assert.equal(bootNew.me.teamId, 1);
  bootA = await (await api("t-esl1", "GET", "/bootstrap")).json();
  assert.equal(bootA.pending.filter(p => p.email === "new@x.com").length, 0);   // 대기 목록에서 빠짐

  // 14) 조직도 수정 권한 — 총관리자·지점장은 전 팀, 부지점장은 자기 팀만
  assert.equal((await api("t-super", "POST", "/admin/members", { email: "bm@x.com", name: "지점장", teamId: null, role: "지점장" })).status, 200);
  // 14-1) 지점장은 팀 소속이 없어도 전 팀 구성원을 고칠 수 있다
  assert.equal((await api("t-bm", "POST", "/admin/members", { email: "fc2@x.com", name: "팀원2", teamId: 2, role: "부팀장" })).status, 200);
  let bootBm = await (await api("t-bm", "GET", "/bootstrap")).json();
  assert.equal(bootBm.me.isBranchHead, true);
  assert.equal(bootBm.members.find(m => m.email === "fc2@x.com").role, "부팀장");
  // 14-2) 지점장은 팀 이름 변경·삭제 가능, 부지점장은 불가
  assert.equal((await api("t-esl1", "POST", "/admin/teams/2", { name: "몰래 변경" })).status, 403);
  assert.equal((await api("t-bm", "POST", "/admin/teams", { name: "3팀" })).status, 200);
  const newTeam = (await (await api("t-bm", "GET", "/bootstrap")).json()).teams.find(t => t.name === "3팀");
  assert.equal((await api("t-bm", "POST", "/admin/teams/" + newTeam.id, { name: "3팀(변경)" })).status, 200);
  // 인원이 있는 팀은 삭제되지 않는다
  assert.equal((await api("t-bm", "DELETE", "/admin/teams/1")).status, 400);
  assert.equal((await api("t-bm", "DELETE", "/admin/teams/" + newTeam.id)).status, 200);
  // 14-3) 부지점장은 여전히 자기 팀만
  assert.equal((await api("t-esl1", "POST", "/admin/members", { email: "fc2@x.com", teamId: 1 })).status, 403);
  assert.equal((await api("t-esl1", "POST", "/admin/members", { email: "fc1@x.com", name: "팀원1", teamId: 1, role: "부팀장" })).status, 200);
  // 14-4) 팀원은 조직도를 못 고친다
  assert.equal((await api("t-fc1", "POST", "/admin/members", { email: "fc1@x.com", role: "지점장" })).status, 403);

  console.log("전체 통과 — 인증·팀 분리·쓰기 권한·소유권·멱등키·부분갱신·초대승인·조직도수정 경계 확인 완료");
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
