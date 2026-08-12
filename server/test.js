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
  CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT, name TEXT, display_name TEXT, status TEXT, grade TEXT, is_admin INTEGER);
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
seed.run(8, "up@x.com", "승급시도", "승인", "FC", 0);       // 승인 경로 직급 상승 시험용
const tok = auth.prepare("INSERT INTO sessions (token, account_id, expires_at) VALUES (?, ?, ?)");
tok.run("t-super", 1, far); tok.run("t-esl1", 2, far); tok.run("t-fc1", 3, far);
tok.run("t-fc2", 4, far); tok.run("t-wait", 5, far); tok.run("t-new", 6, far);
tok.run("t-bm", 7, far); tok.run("t-up", 8, far);
auth.close();

const FILES = "./test-files";
rmSync(FILES, { force: true, recursive: true });
const srv = spawn(process.execPath, ["server.js"], {
  env: { ...process.env, PORT: String(PORT), DB_FILE: DATA, AUTH_DB_FILE: AUTH, FILE_DIR: FILES },
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

  // 1) 인증 경계: 토큰 없음 401
  assert.equal((await fetch(BASE + "/bootstrap")).status, 401);
  // 마이가디언에서 아직 '대기'인 계정 — 자료는 못 보되(403) 우리 가입 신청은 할 수 있어야 한다.
  // (막아버리면 구글 로그인만 하고 승인 대기열에 들어오지 못한다)
  const waitRes = await api("t-wait", "GET", "/bootstrap");
  assert.equal(waitRes.status, 403);
  assert.equal((await waitRes.json()).needJoin, true);

  // 2) 총관리자: 팀 2개 생성, 구성원 배치 (관리자 임명 포함)
  assert.equal((await api("t-super", "POST", "/admin/teams", { name: "1팀" })).status, 200);
  assert.equal((await api("t-super", "POST", "/admin/teams", { name: "2팀" })).status, 200);
  for (const m of [
    { email: "esl1@x.com", name: "부지점장1", teamId: 1, role: "부지점장" },
    { email: "fc1@x.com", name: "팀원1", teamId: 1 },
    { email: "fc2@x.com", name: "팀원2", teamId: 2 }
  ]) assert.equal((await api("t-super", "POST", "/admin/members", m)).status, 200);

  // 3) 조직도는 전체 공개 — 팀·명단은 누구에게나 다 보인다 (2026-08-02 사용자 지시).
  // 가리는 것은 자료(공지·일정·업적·TA)이고 그건 아래 항목들이 확인한다.
  let b = await (await api("t-fc1", "GET", "/bootstrap")).json();
  assert.deepEqual(b.teams.map(t => t.name), ["1팀", "2팀"]);
  assert.deepEqual(b.members.map(m => m.email).sort(), ["esl1@x.com", "fc1@x.com", "fc2@x.com"]);
  assert.equal(b.me.seesAll, false);          // 명단이 다 보인다고 열람 권한이 생기는 건 아니다
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
  // TA 일지는 지점 전체가 함께 본다 — 2팀 팀원에게도 1팀 기록이 보인다 (2026-08-02)
  assert.equal((await (await api("t-fc2", "GET", "/ta?month=2026-08")).json()).length, 2);
  // 보이기만 하지 고치지는 못한다 — 쓰기는 본인·자기 팀 관리자만
  assert.equal((await api("t-fc2", "POST", "/ta/" + taRes.ids[0], { result: "침범" })).status, 403);
  assert.equal((await api("t-fc2", "DELETE", "/ta/" + taRes.ids[0])).status, 403);
  // 주의 표시 — 기간과 무관하게 모아본다 (알바몬 블랙 걸러내기)
  assert.equal((await api("t-fc1", "POST", "/ta/" + taRes.ids[0], { flag: "주의" })).status, 200);
  const flagged = await (await api("t-fc2", "GET", "/ta?flagged=1")).json();
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].flag, "주의");
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

  // 10-1) 미션: 삭제는 관리자만.
  // 미션 상태(요청/진행중/완료) API는 걷어냈다 — 달성 여부는 task_done이 판정한다.
  const t1 = await (await api("t-esl1", "POST", "/tasks", { title: "개인 미션", targets: ["fc1@x.com"], due: "2026-08-10" })).json();
  const t2 = await (await api("t-esl1", "POST", "/tasks", { title: "팀 미션", targets: "전체" })).json();
  assert.ok(t2.id);
  assert.equal((await api("t-fc1", "POST", "/tasks/" + t1.id + "/status", { status: "진행중" })).status, 404);
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

  // 15) 날짜 형식 — 시트에서 온 "8/1" 같은 값은 400으로 거절 (조용히 사라지지 않게)
  assert.equal((await api("t-fc1", "POST", "/ta", { rows: [{ date: "8/1", cand_name: "홍길동" }] })).status, 400);
  assert.equal((await api("t-fc1", "POST", "/events", { date: "2026.9.1", memberEmail: "fc1@x.com", kind: "상담" })).status, 400);
  assert.equal((await api("t-fc1", "POST", "/perf", { month: "2026-09", rows: [{ member: "팀원1", contract_date: "9/2" }] })).status, 400);

  // 16) 지난달 일정 복사 — 날짜가 아니라 「몇째 주 무슨 요일」을 지킨다.
  // 10/5(첫째 주 월) → 11/2(첫째 주 월). 날짜로 옮기면 11/5는 목요일이라 조회가 엉뚱한 날로 간다.
  await api("t-esl1", "POST", "/events", { date: "2026-10-05", kind: "회의", title: "월간 조회", teamId: 1 });
  await api("t-esl1", "POST", "/events", { date: "2026-10-12", kind: "교육", title: "정기 교육", teamId: 1 });
  let cp = await (await api("t-esl1", "POST", "/events/copy-month", { from: "2026-10", to: "2026-11", teamId: 1 })).json();
  assert.equal(cp.copied, 2);
  const nov = await (await api("t-esl1", "GET", "/events?from=2026-11-01&to=2026-11-30")).json();
  assert.ok(nov.some(e => e.date === "2026-11-02" && e.title === "월간 조회"));
  assert.ok(nov.some(e => e.date === "2026-11-09" && e.title === "정기 교육"));
  nov.filter(e => ["월간 조회", "정기 교육"].includes(e.title))
     .forEach(e => assert.equal(new Date(e.date + "T00:00:00").getDay(), 1));   // 전부 월요일
  // 다시 실행하면 전부 건너뛴다 (중복 생성 없음)
  cp = await (await api("t-esl1", "POST", "/events/copy-month", { from: "2026-10", to: "2026-11", teamId: 1 })).json();
  assert.equal(cp.copied, 0); assert.equal(cp.skipped, 2);
  // 다른 팀으로는 복사 못 한다
  assert.equal((await api("t-esl1", "POST", "/events/copy-month", { from: "2026-10", to: "2026-11", teamId: 2 })).status, 403);

  // 17) TA 일지 — 읽기는 지점 전체, 쓰기는 본인·관리자 (2026-08-02 사용자 지시)
  await api("t-fc1", "POST", "/ta", { rows: [{ date: "2026-12-01", cand_name: "후보자A", real_phone: "010-1111-2222" }] });
  await api("t-super", "POST", "/admin/members", { email: "new@x.com", name: "신입", teamId: 1, role: "팀원" });
  const otherTa = await (await api("t-new", "GET", "/ta?month=2026-12")).json();
  assert.equal(otherTa.length, 1);                       // 같은 팀 팀원도 본다
  const ownTa = await (await api("t-fc1", "GET", "/ta?month=2026-12")).json();
  assert.equal(ownTa.length, 1);
  const mgrTa = await (await api("t-esl1", "GET", "/ta?month=2026-12")).json();
  assert.equal(mgrTa.length, 1);
  assert.equal((await api("t-new", "POST", "/ta/" + otherTa[0].id, { note: "침범" })).status, 403);

  // 18) 한국 시간 — 저장 날짜가 KST 기준인지
  const kstToday = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  await api("t-fc1", "POST", "/attendance", { present: true });   // 날짜 미지정 → 서버 today()
  const attToday = await (await api("t-fc1", "GET", "/attendance?date=" + kstToday)).json();
  assert.equal(attToday.filter(a => a.email === "fc1@x.com").length, 1);

  // 19) 동명이인 — 같은 이름 두 사람이 서로의 기록을 건드리지 못한다
  // fc1(팀원1)과 같은 이름으로 fc2를 1팀에 넣는다
  assert.equal((await api("t-super", "POST", "/admin/members", { email: "fc2@x.com", name: "팀원1", teamId: 1, role: "팀원" })).status, 200);

  // 각자 자기 이름으로 TA를 쓴다 — 이메일로 소유가 갈린다
  const taA = await (await api("t-fc1", "POST", "/ta", { rows: [{ date: "2027-01-05", cand_name: "A후보" }] })).json();
  const taB = await (await api("t-fc2", "POST", "/ta", { rows: [{ date: "2027-01-06", cand_name: "B후보" }] })).json();
  assert.equal(taA.ids.length, 1); assert.equal(taB.ids.length, 1);
  // 동명이인이라도 남의 일지는 수정·삭제 불가
  assert.equal((await api("t-fc2", "POST", "/ta/" + taA.ids[0], { result: "가로채기" })).status, 403);
  assert.equal((await api("t-fc1", "DELETE", "/ta/" + taB.ids[0])).status, 403);
  // 본인 것은 된다
  assert.equal((await api("t-fc1", "POST", "/ta/" + taA.ids[0], { result: "내 기록" })).status, 200);
  // 조회는 지점 전체지만 소유자는 이메일로 갈린다 (동명이인이 섞이지 않는다)
  const taSeenA = await (await api("t-fc1", "GET", "/ta?month=2027-01")).json();
  assert.equal(taSeenA.length, 2);
  const own = taSeenA.filter(r => r.author_email === "fc1@x.com");
  assert.equal(own.length, 1);
  assert.equal(own[0].cand_name, "A후보");

  // 업적도 동명이인이 갈린다
  await api("t-fc1", "POST", "/perf", { month: "2027-01", rows: [{ member: "팀원1", memberEmail: "fc1@x.com", contract_date: "2027-01-10", canp: 100 }] });
  await api("t-fc2", "POST", "/perf", { month: "2027-01", rows: [{ member: "팀원1", memberEmail: "fc2@x.com", contract_date: "2027-01-11", canp: 200 }] });
  const dupPerf = await (await api("t-esl1", "GET", "/perf?month=2027-01")).json();
  const mineA = dupPerf.rows.filter(r => r.member_email === "fc1@x.com");
  const mineB = dupPerf.rows.filter(r => r.member_email === "fc2@x.com");
  assert.equal(mineA.length, 1); assert.equal(mineA[0].canp, 100);
  assert.equal(mineB.length, 1); assert.equal(mineB[0].canp, 200);
  // 남의 업적 수정 차단
  assert.equal((await api("t-fc1", "POST", "/perf/" + mineB[0].id, { canp: 999 })).status, 403);
  // 팀원이 남의 이메일로 입력하려 해도 차단
  assert.equal((await api("t-fc1", "POST", "/perf", { month: "2027-01", rows: [{ member: "팀원1", memberEmail: "fc2@x.com", canp: 1 }] })).status, 403);

  // 20) 직급은 조직도 기준 — 마이가디언이 '대기'라도 조직도상 부지점장이면 관리자다.
  // (마이가디언 승인이 늦어 팀 운영이 막히는 일이 없게)
  assert.equal((await api("t-super", "POST", "/admin/members",
    { email: "wait@x.com", name: "대기자", teamId: 2, role: "부지점장" })).status, 200);
  const waitBoot = await (await api("t-wait", "GET", "/bootstrap")).json();
  assert.equal(waitBoot.me.grade, "ESL");
  assert.equal(waitBoot.me.isManager, true);
  assert.equal(waitBoot.me.isSuper, false);           // 총관리자 권한까지 딸려오면 안 된다
  assert.equal(waitBoot.me.seesAll, false);           // 열람은 자기 팀만
  assert.equal((await api("t-wait", "POST", "/notices", { title: "2팀 공지", teamId: 2 })).status, 200);
  assert.equal((await api("t-wait", "POST", "/notices", { title: "1팀 침범", teamId: 1 })).status, 403);

  // 21) 내 정보 — 본인 실명 확인. 팀·직급은 여기서 못 바꾼다(권한 상승 차단).
  const meBefore = await (await api("t-fc1", "GET", "/me")).json();
  assert.equal(meBefore.done, false);
  assert.equal((await api("t-fc1", "POST", "/me", { name: "김", phone: "" })).status, 400);      // 너무 짧음
  assert.equal((await api("t-fc1", "POST", "/me", { name: "김일번", phone: "010-1" })).status, 400); // 번호 형식
  assert.equal((await api("t-fc1", "POST", "/me",
    { name: "김일번", phone: "010-1234-5678", role: "부지점장", teamId: 2, isManager: true })).status, 200);
  const meAfter = await (await api("t-fc1", "GET", "/me")).json();
  assert.equal(meAfter.name, "김일번");
  assert.equal(meAfter.phone, "010-1234-5678");
  assert.equal(meAfter.done, true);
  const meBoot = await (await api("t-fc1", "GET", "/bootstrap")).json();
  assert.equal(meBoot.me.isManager, false);          // 직급·관리자 권한은 그대로
  assert.equal(meBoot.me.teamId, 1);                 // 팀도 그대로

  // 22) 생일·위촉일 — MM-DD만 받고(나이 비공개), 명단에 실려 지점 전체가 챙긴다
  assert.equal((await api("t-fc1", "POST", "/me", { name: "김일번", birthday: "2026-08-15" })).status, 400);
  assert.equal((await api("t-fc1", "POST", "/me", { name: "김일번", birthday: "13-01" })).status, 400);
  assert.equal((await api("t-fc1", "POST", "/me", { name: "김일번", birthday: "08-15", joinedAt: "2024-03-01" })).status, 200);
  const bdBoot = await (await api("t-fc2", "GET", "/bootstrap")).json();
  const seen = bdBoot.members.filter(m => m.email === "fc1@x.com")[0];
  assert.equal(seen.birthday, "08-15");
  assert.equal(seen.joined_at, "2024-03-01");

  // 23) TA 일지 잠금 — 지점 공용 비밀번호. 후보자 실명·연락처가 든 화면이라 한 겹 잠근다.
  let lock = await (await api("t-fc1", "GET", "/ta/lock")).json();
  assert.equal(lock.enabled, false);                        // 비밀번호 설정 전에는 잠그지 않는다
  assert.equal((await api("t-fc1", "POST", "/ta/password", { password: "1234" })).status, 403);  // 팀원 불가
  assert.equal((await api("t-super", "POST", "/ta/password", { password: "12" })).status, 400);  // 너무 짧음
  assert.equal((await api("t-super", "POST", "/ta/password", { password: "harang24" })).status, 200);
  // 설정 뒤엔 읽기도 쓰기도 막힌다
  const locked = await api("t-fc1", "GET", "/ta?month=2026-08");
  assert.equal(locked.status, 403);
  assert.equal((await locked.json()).taLocked, true);
  assert.equal((await api("t-fc1", "POST", "/ta", { rows: [{ date: "2026-08-09", cand_name: "잠김" }] })).status, 403);
  assert.equal((await api("t-fc1", "POST", "/ta/unlock", { password: "틀림" })).status, 403);
  assert.equal((await api("t-fc1", "POST", "/ta/unlock", { password: "harang24" })).status, 200);
  assert.equal((await api("t-fc1", "GET", "/ta?month=2026-08")).status, 200);
  lock = await (await api("t-fc1", "GET", "/ta/lock")).json();
  assert.equal(lock.unlocked, true);
  // 열람 기록 — 지점장·총관리자만 본다
  assert.equal((await api("t-fc1", "GET", "/ta/access")).status, 403);
  const acc = await (await api("t-super", "GET", "/ta/access")).json();
  assert.ok(acc.some(a => a.email === "fc1@x.com"));
  // 비밀번호를 바꾸면 기존 해제는 무효
  assert.equal((await api("t-super", "POST", "/ta/password", { password: "harang25" })).status, 200);
  assert.equal((await api("t-fc1", "GET", "/ta?month=2026-08")).status, 403);
  assert.equal((await api("t-fc1", "POST", "/ta/unlock", { password: "harang25" })).status, 200);

  // 24) 보관기간 6개월 — 서버가 켜질 때 지운다
  const old = new Date(Date.now() + 9 * 3600e3);
  old.setMonth(old.getMonth() - 7);
  const oldDate = old.toISOString().slice(0, 10);
  await api("t-fc1", "POST", "/ta", { rows: [{ date: oldDate, cand_name: "7개월전" }] });
  assert.equal((await (await api("t-fc1", "GET", "/ta?month=" + oldDate.slice(0, 7))).json()).length, 1);
  await new Promise(done => {
    const boot = spawn(process.execPath, ["server.js"], {
      env: { ...process.env, PORT: "18789", DB_FILE: DATA, AUTH_DB_FILE: AUTH }, stdio: "ignore"
    });
    setTimeout(() => { boot.kill(); done(); }, 1200);
  });
  assert.equal((await (await api("t-fc1", "GET", "/ta?month=" + oldDate.slice(0, 7))).json()).length, 0);

  // 25) 반복 일정 — 규칙을 저장하지 않고 그 자리에서 날짜를 펼친다
  const rw = await (await api("t-esl1", "POST", "/events",
    { date: "2027-03-02", kind: "교육", title: "주간 스터디", repeat: { every: "week", count: 4 } })).json();
  assert.equal(rw.count, 4);
  const wk = await (await api("t-esl1", "GET", "/events?from=2027-03-01&to=2027-03-31")).json();
  assert.deepEqual(wk.filter(e => e.title === "주간 스터디").map(e => e.date),
    ["2027-03-02", "2027-03-09", "2027-03-16", "2027-03-23"]);
  // 매월 31일 — 그 달에 31일이 없으면 말일로 당긴다 (다음 달로 새지 않게)
  const rm = await (await api("t-esl1", "POST", "/events",
    { date: "2027-01-31", kind: "회의", title: "월말 회의", repeat: { every: "month", count: 3 } })).json();
  assert.equal(rm.count, 3);
  const mm = await (await api("t-esl1", "GET", "/events?from=2027-01-01&to=2027-04-30")).json();
  assert.deepEqual(mm.filter(e => e.title === "월말 회의").map(e => e.date).sort(),
    ["2027-01-31", "2027-02-28", "2027-03-31"]);

  // 26) 도입 현황 — 단계별 집계. 숫자만 나오므로 TA 잠금과 무관하게 열린다.
  await api("t-fc1", "POST", "/ta", { rows: [
    { date: "2027-05-04", cand_name: "가", stage: "통화" },
    { date: "2027-05-05", cand_name: "나", stage: "면접" },
    { date: "2027-05-06", cand_name: "다", stage: "위촉" },
    { date: "2027-05-07", cand_name: "라", stage: "거절" },
    { date: "2027-05-08", cand_name: "마" }                    // 빈 값은 통화로 본다
  ] });
  const rc = await (await api("t-fc2", "GET", "/recruit?month=2027-05")).json();
  assert.equal(rc.total["통화"], 2);
  assert.equal(rc.total["면접"], 1);
  assert.equal(rc.total["위촉"], 1);
  assert.equal(rc.total["거절"], 1);
  assert.equal(rc.byMember.length, 1);
  assert.equal(rc.byMember[0].email, "fc1@x.com");
  // 후보자 이름·연락처가 새어나가지 않는다
  assert.ok(!JSON.stringify(rc).includes("가"));

  // 27) 조직도 자리에 계정 붙이기 — 「미연결」 자리를 실제 계정으로
  await api("t-super", "POST", "/admin/members", { email: "빈자리@미등록.local", name: "안창민", teamId: 1, role: "부팀장" });
  await api("t-fc1", "POST", "/ta", { rows: [{ date: "2027-07-01", cand_name: "이관확인" }] });
  // 자리 이름으로 남긴 일정도 함께 옮겨지는지
  await api("t-super", "POST", "/events", { date: "2027-07-02", memberEmail: "빈자리@미등록.local", kind: "상담", title: "자리 일정", teamId: 1 });
  assert.equal((await api("t-fc1", "POST", "/admin/members/link",
    { seatEmail: "빈자리@미등록.local", accountEmail: "bm@x.com" })).status, 403);   // 팀원은 불가
  assert.equal((await api("t-super", "POST", "/admin/members/link",
    { seatEmail: "빈자리@미등록.local", accountEmail: "없는사람@x.com" })).status, 404);  // 로그인한 적 없는 계정
  assert.equal((await api("t-super", "POST", "/admin/members/link",
    { seatEmail: "빈자리@미등록.local", accountEmail: "bm@x.com" })).status, 200);
  const afterLink = await (await api("t-super", "GET", "/bootstrap")).json();
  assert.ok(!afterLink.members.some(m => m.email === "빈자리@미등록.local"));   // 빈 자리는 사라진다
  const linked = afterLink.members.filter(m => m.email === "bm@x.com")[0];
  assert.equal(linked.role, "부팀장");                    // 자리의 직급·팀을 물려받는다
  assert.equal(linked.team_id, 1);
  const movedEv = await (await api("t-super", "GET", "/events?from=2027-07-02&to=2027-07-02")).json();
  assert.equal(movedEv.filter(e => e.member_email === "bm@x.com").length, 1);   // 기록도 따라온다
  // 이미 계정이 붙은 자리에는 다시 붙이지 못한다
  assert.equal((await api("t-super", "POST", "/admin/members/link",
    { seatEmail: "bm@x.com", accountEmail: "new@x.com" })).status, 400);

  // 28) 조직도 순서 — 끌어서 놓은 순서를 그대로 저장한다
  assert.equal((await api("t-fc1", "POST", "/admin/members/order",
    { teamId: 1, emails: ["fc1@x.com"] })).status, 403);          // 팀원은 불가
  assert.equal((await api("t-esl1", "POST", "/admin/members/order",
    { teamId: 2, emails: ["fc2@x.com"] })).status, 403);          // 남의 팀은 불가
  assert.equal((await api("t-esl1", "POST", "/admin/members/order",
    { teamId: 1, emails: ["fc1@x.com", "bm@x.com", "esl1@x.com"] })).status, 200);
  const ordered = await (await api("t-super", "GET", "/bootstrap")).json();
  const byEmail = Object.fromEntries(ordered.members.map(m => [m.email, m.sort_order]));
  assert.equal(byEmail["fc1@x.com"], 0);
  assert.equal(byEmail["bm@x.com"], 1);
  assert.equal(byEmail["esl1@x.com"], 2);

  // 29) 지난 보고 불러오기 — 남의 보고가 아니라 본인 것, 오늘 것 말고 지난 것
  await api("t-fc1", "POST", "/attendance", { date: "2027-09-01", present: true, work: "오전 조회", lunch: "팀 점심" });
  await api("t-fc2", "POST", "/attendance", { date: "2027-09-02", present: true, work: "남의 보고" });
  const last = await (await api("t-fc1", "GET", "/attendance/last?date=2027-09-03")).json();
  assert.equal(last.work, "오전 조회");
  assert.equal(last.email, "fc1@x.com");         // 남의 보고는 오지 않는다
  // 지금 쓰고 있는 날짜 자신은 후보가 아니다
  const other = await (await api("t-fc1", "GET", "/attendance/last?date=2027-09-01")).json();
  assert.notEqual(other.date, "2027-09-01");
  const none = await (await api("t-new", "GET", "/attendance/last")).json();
  assert.equal(none.id, undefined);              // 쓴 적 없으면 빈 값

  // 30) 목표가 조용히 지워지지 않는다 — 보내지 않은 항목은 손대지 않는다
  await api("t-esl1", "POST", "/perf/goals", { teamId: 1, month: "2027-11", goals: [{ member: "팀원1", goal: "1,000(100)", intro: 2 }] });
  // 다른 사람 목표만 고쳐 저장 — 팀원1 것은 보내지 않는다
  await api("t-esl1", "POST", "/perf/goals", { teamId: 1, month: "2027-11", goals: [{ member: "부지점장1", goal: "2,000(200)" }] });
  let pgoal = await (await api("t-esl1", "GET", "/perf?month=2027-11")).json();
  let keep = pgoal.goals.filter(g => g.member === "팀원1")[0];
  assert.equal(keep.goal, "1,000(100)");        // 남아 있어야 한다
  assert.equal(keep.intro, 2);
  // 일부러 비우면 지워진다 (빈 문자열을 명시적으로 보낼 때만)
  await api("t-esl1", "POST", "/perf/goals", { teamId: 1, month: "2027-11", goals: [{ member: "팀원1", goal: "" }] });
  pgoal = await (await api("t-esl1", "GET", "/perf?month=2027-11")).json();
  keep = pgoal.goals.filter(g => g.member === "팀원1")[0];
  assert.equal(keep.goal, "");
  assert.equal(keep.intro, 2);                  // 도입은 그대로

  // 31) 일괄 저장은 전부 되거나 전부 안 되거나 — 중간에 막히면 앞줄도 남지 않는다
  const before = (await (await api("t-fc1", "GET", "/ta?month=2027-12")).json()).length;
  const mixed = await api("t-fc1", "POST", "/ta", { rows: [
    { date: "2027-12-01", cand_name: "첫줄" },
    { date: "2027-12-02", cand_name: "남의것", authorEmail: "fc2@x.com" }   // 팀원은 남의 일지를 못 넣는다
  ] });
  assert.equal(mixed.status, 403);
  const after = (await (await api("t-fc1", "GET", "/ta?month=2027-12")).json()).length;
  assert.equal(after, before);                  // 첫 줄도 저장되지 않았다
  // 날짜 형식이 틀리면 아예 시작하지 않는다
  assert.equal((await api("t-fc1", "POST", "/ta", { rows: [
    { date: "2027-12-03", cand_name: "정상" }, { date: "12월 4일", cand_name: "형식오류" }
  ] })).status, 400);
  assert.equal((await (await api("t-fc1", "GET", "/ta?month=2027-12")).json()).length, before);

  // 32) 명단에서 내리기 — 기록이 있으면 지우지 않고 내린다
  await api("t-super", "POST", "/admin/members", { email: "그만둔@x.com", name: "퇴사자", teamId: 1, role: "팀원" });
  // 기록이 없으면 실제로 지운다 (잘못 만든 줄)
  let del = await (await api("t-super", "DELETE", "/admin/members/" + encodeURIComponent("그만둔@x.com"))).json();
  assert.equal(del.removed, true);
  // 기록이 있으면 내리기만 한다
  await api("t-super", "POST", "/admin/members", { email: "new@x.com", name: "신입", teamId: 1, role: "팀원" });
  await api("t-new", "POST", "/attendance", { date: "2027-10-01", present: true, work: "기록 남김" });
  del = await (await api("t-super", "DELETE", "/admin/members/" + encodeURIComponent("new@x.com"))).json();
  assert.equal(del.removed, false);
  const afterOff = await (await api("t-super", "GET", "/bootstrap")).json();
  const gone = afterOff.members.filter(m => m.email === "new@x.com")[0];
  assert.equal(gone.active, 0);                       // 명단에는 남아 있되 내려간 상태
  assert.ok(gone.left_at);
  // 내려간 사람은 로그인해도 자료를 못 본다
  const leftBoot = await api("t-new", "GET", "/bootstrap");
  assert.equal(leftBoot.status, 403);
  // 기록은 그대로 있다
  const keptAtt = await (await api("t-super", "GET", "/attendance?date=2027-10-01")).json();
  assert.ok(keptAtt.some(a => a.email === "new@x.com"));
  // 다시 올릴 수 있다
  assert.equal((await api("t-super", "POST", "/admin/members/" + encodeURIComponent("new@x.com") + "/restore")).status, 200);
  assert.equal((await api("t-new", "GET", "/bootstrap")).status, 200);

  // 33) 미션 대상은 부여 시점 명단으로 고정 — 팀원이 늘어도 지난 미션 달성률이 안 떨어진다
  const tk = await (await api("t-esl1", "POST", "/tasks", { teamId: 1, title: "부여시점 확인" })).json();
  let tasks = await (await api("t-esl1", "GET", "/tasks")).json();
  let mine = tasks.filter(t => t.id === tk.id)[0];
  assert.ok(Array.isArray(mine.targets));               // 「전체」가 아니라 명단이 박혀 있다
  const targetCount = mine.targets.length;
  await api("t-super", "POST", "/admin/members", { email: "나중에@x.com", name: "나중입사", teamId: 1, role: "팀원" });
  tasks = await (await api("t-esl1", "GET", "/tasks")).json();
  mine = tasks.filter(t => t.id === tk.id)[0];
  assert.equal(mine.targets.length, targetCount);       // 사람이 늘어도 분모는 그대로

  // 34) 지난달 일정 가져오기 — 날짜가 아니라 요일을 지킨다
  // 2027-03-01은 월요일. 첫째 주 월요일 → 4월 첫째 주 월요일(2027-04-05)이어야 한다.
  await api("t-esl1", "POST", "/events", { date: "2027-03-01", kind: "회의", title: "월요 조회", teamId: 1 });
  const cpw = await (await api("t-esl1", "POST", "/events/copy-month", { from: "2027-03", to: "2027-04", teamId: 1 })).json();
  assert.ok(cpw.copied > 0);
  const aprEvs = await (await api("t-esl1", "GET", "/events?from=2027-04-01&to=2027-04-30")).json();
  const moved = aprEvs.filter(e => e.title === "월요 조회")[0];
  assert.ok(moved, "복사된 일정이 있어야 한다");
  assert.equal(new Date(moved.date + "T00:00:00").getDay(), 1);   // 여전히 월요일

  // 35) 일정 세부 — 면접관·교육 대상·차월이 저장되고 그대로 돌아온다
  const evTS1 = await (await api("t-esl1", "POST", "/events", {
    date: "2027-06-07", kind: "TS1", title: "1차 면접 · 면접관 부지점장1", teamId: 1,
    place: "본부 회의실", detail: { people: ["esl1@x.com", "fc1@x.com"] }
  })).json();
  let evs6 = await (await api("t-esl1", "GET", "/events?from=2027-06-01&to=2027-06-30")).json();
  let rowTS1 = evs6.filter(e => e.id === evTS1.id)[0];
  assert.equal(JSON.parse(rowTS1.detail).people.length, 2);
  assert.equal(rowTS1.place, "본부 회의실");
  // 차월교육 — 숫자도 함께
  const evCha = await (await api("t-esl1", "POST", "/events", {
    date: "2027-06-14", kind: "차월교육", title: "3차월 교육", teamId: 1,
    detail: { num: 3, people: ["fc1@x.com"] }
  })).json();
  evs6 = await (await api("t-esl1", "GET", "/events?from=2027-06-01&to=2027-06-30")).json();
  assert.equal(JSON.parse(evs6.filter(e => e.id === evCha.id)[0].detail).num, 3);
  // 수정해도 세부가 남는다 (보내지 않으면 그대로)
  assert.equal((await api("t-esl1", "POST", "/events/" + evTS1.id, { start: "14:00" })).status, 200);
  evs6 = await (await api("t-esl1", "GET", "/events?from=2027-06-01&to=2027-06-30")).json();
  rowTS1 = evs6.filter(e => e.id === evTS1.id)[0];
  assert.equal(JSON.parse(rowTS1.detail).people.length, 2);
  assert.equal(rowTS1.start, "14:00");
  // 반복으로 한 달치 — 세부가 모든 회차에 붙는다
  const rep6 = await (await api("t-esl1", "POST", "/events", {
    date: "2027-07-05", kind: "GROW", title: "GROW 교육", teamId: 1,
    detail: { people: ["fc1@x.com"] }, repeat: { every: "week", count: 4 }
  })).json();
  assert.equal(rep6.count, 4);
  const jul = await (await api("t-esl1", "GET", "/events?from=2027-07-01&to=2027-07-31")).json();
  const grows = jul.filter(e => e.kind === "GROW");
  assert.equal(grows.length, 4);
  grows.forEach(e => assert.equal(JSON.parse(e.detail).people[0], "fc1@x.com"));

  // 36) 자리 이어받기가 미션 대상도 옮긴다 — 안 옮기면 미션이 사라지고 분모만 남는다
  await api("t-super", "POST", "/admin/members", { email: "이어받을자리@미등록.local", name: "이어받을사람", teamId: 1, role: "팀원" });
  const mtk = await (await api("t-esl1", "POST", "/tasks", { teamId: 1, title: "대상 이관 확인" })).json();
  let mts = (await (await api("t-esl1", "GET", "/tasks")).json()).filter(t => t.id === mtk.id)[0];
  assert.ok(mts.targets.includes("이어받을자리@미등록.local"));
  assert.equal((await api("t-super", "POST", "/admin/members/link",
    { seatEmail: "이어받을자리@미등록.local", accountEmail: "wait@x.com" })).status, 200);
  mts = (await (await api("t-esl1", "GET", "/tasks")).json()).filter(t => t.id === mtk.id)[0];
  assert.ok(mts.targets.includes("wait@x.com"));                     // 계정으로 옮겨졌다
  assert.ok(!mts.targets.includes("이어받을자리@미등록.local"));      // 빈 자리는 빠졌다

  // 37) TA 비밀번호를 계속 찍어보면 잠깐 막힌다
  for (let i = 0; i < 5; i++) await api("t-new", "POST", "/ta/unlock", { password: "틀림" + i });
  assert.equal((await api("t-new", "POST", "/ta/unlock", { password: "harang25" })).status, 429);

  // 38) 직급이 곧 권한이다 — 관리자가 자기 직급을 올려 지점장이 되지 못한다 (코덱스 지적)
  assert.equal((await api("t-esl1", "POST", "/admin/members",
    { email: "esl1@x.com", role: "지점장" })).status, 403);
  // 남에게도 자기보다 높은 직급은 못 준다
  assert.equal((await api("t-esl1", "POST", "/admin/members",
    { email: "fc1@x.com", role: "지점장" })).status, 403);
  // 총관리자는 된다
  assert.equal((await api("t-super", "POST", "/admin/members",
    { email: "fc1@x.com", role: "팀장" })).status, 200);

  // 39) 전체열람은 「보는」 권한이다 — 남의 팀 기록을 고치거나 지우지 못한다 (코덱스 지적)
  await api("t-super", "POST", "/admin/members", { email: "esl1@x.com", name: "부지점장1", teamId: 1, role: "부지점장", canViewAll: true });
  // 앞선 동명이인 테스트가 fc2를 1팀으로 옮겨 놨다 — 다시 2팀으로 돌려놓고 시작한다
  await api("t-super", "POST", "/admin/members", { email: "fc2@x.com", name: "팀원2", teamId: 2, role: "팀원" });
  await api("t-fc2", "POST", "/ta/unlock", { password: "harang25" });
  await api("t-esl1", "POST", "/ta/unlock", { password: "harang25" });
  await api("t-fc2", "POST", "/ta", { rows: [{ date: "2027-08-03", cand_name: "2팀후보" }] });
  const taAug = await (await api("t-esl1", "GET", "/ta?month=2027-08")).json();
  const otherTa2 = taAug.filter(r => r.team_id === 2)[0];
  assert.ok(otherTa2, "전체열람이면 남의 팀 일지가 보이긴 한다");
  assert.equal((await api("t-esl1", "POST", "/ta/" + otherTa2.id, { note: "침범" })).status, 403);
  assert.equal((await api("t-esl1", "DELETE", "/ta/" + otherTa2.id)).status, 403);
  const pf2 = await (await api("t-fc2", "POST", "/perf", { month: "2027-08", rows: [{ member: "팀원2", memberEmail: "fc2@x.com", canp: 10 }] })).json();
  assert.equal((await api("t-esl1", "POST", "/perf/" + pf2.ids[0], { canp: 999 })).status, 403);
  assert.equal((await api("t-esl1", "DELETE", "/perf/" + pf2.ids[0])).status, 403);

  // 40) 계정 연결이 남의 팀 사람을 끌어오지 못한다 (코덱스 지적)
  await api("t-super", "POST", "/admin/members", { email: "빈자리2@미등록.local", name: "빈자리2", teamId: 1, role: "팀원" });
  assert.equal((await api("t-esl1", "POST", "/admin/members/link",
    { seatEmail: "빈자리2@미등록.local", accountEmail: "fc2@x.com" })).status, 403);

  // 41) 달력에 없는 날짜는 거절한다 — 모양만 맞으면 통과하던 것 (코덱스 지적)
  await api("t-fc1", "POST", "/ta/unlock", { password: "harang25" });
  assert.equal((await api("t-fc1", "POST", "/ta", { rows: [{ date: "2026-99-99", cand_name: "가짜날짜" }] })).status, 400);
  assert.equal((await api("t-fc1", "POST", "/events", { date: "2027-02-30", memberEmail: "fc1@x.com", kind: "상담" })).status, 400);
  // 수정 경로에도 검증이 있다
  const okEv = await (await api("t-fc1", "POST", "/events", { date: "2027-02-28", memberEmail: "fc1@x.com", kind: "상담" })).json();
  assert.equal((await api("t-fc1", "POST", "/events/" + okEv.id, { date: "8/1" })).status, 400);

  // 42) 목표의 주인이 이메일이다 — 같은 팀 동명이인의 목표가 서로를 덮어쓰지 않는다 (코덱스 지적)
  await api("t-super", "POST", "/admin/members", { email: "동명A@x.com", name: "홍길동", teamId: 1, role: "팀원" });
  await api("t-super", "POST", "/admin/members", { email: "동명B@x.com", name: "홍길동", teamId: 1, role: "팀원" });
  await api("t-esl1", "POST", "/perf/goals", { teamId: 1, month: "2027-12", goals: [
    { member: "홍길동", memberEmail: "동명A@x.com", goal: "A목표", intro: 1 }
  ] });
  await api("t-esl1", "POST", "/perf/goals", { teamId: 1, month: "2027-12", goals: [
    { member: "홍길동", memberEmail: "동명B@x.com", goal: "B목표", intro: 2 }
  ] });
  const twins = (await (await api("t-esl1", "GET", "/perf?month=2027-12")).json())
    .goals.filter(g => g.member === "홍길동");
  assert.equal(twins.length, 2, "두 사람의 목표가 각각 남아야 한다");
  assert.equal(twins.filter(g => g.member_email === "동명a@x.com")[0].goal, "A목표");
  assert.equal(twins.filter(g => g.member_email === "동명b@x.com")[0].goal, "B목표");
  assert.equal(twins.filter(g => g.member_email === "동명b@x.com")[0].intro, 2);

  // 43) 자리 이어받기가 같은 날 출석을 버리지 않는다 — 빈 칸만 채운다 (코덱스 지적)
  await api("t-super", "POST", "/admin/members", { email: "겹치는자리@미등록.local", name: "겹침", teamId: 1, role: "팀원" });
  // 자리 쪽 출석은 API로 못 넣는다(각자 본인 것만 쓴다) — DB에 직접 넣어 상황을 만든다
  {
    const d = new DatabaseSync(DATA);
    d.prepare(`INSERT INTO attendance (email, date, present, work, afternoon, checked_at)
               VALUES (?, ?, 1, ?, ?, ?)`)
      .run("겹치는자리@미등록.local", "2027-03-10", "자리쪽 오전", "자리쪽 오후", "2027-03-10T08:40:00+09:00");
    d.close();
  }
  // 계정 쪽에는 같은 날 점심만 있다
  await api("t-bm", "POST", "/attendance", { date: "2027-03-10", present: false, lunch: "계정쪽 점심" });
  assert.equal((await api("t-super", "POST", "/admin/members/link",
    { seatEmail: "겹치는자리@미등록.local", accountEmail: "bm@x.com" })).status, 200);
  const merged = (await (await api("t-super", "GET", "/attendance?date=2027-03-10")).json())
    .filter(a => a.email === "bm@x.com");
  assert.equal(merged.length, 1, "같은 날 두 줄이 남으면 안 된다");
  assert.equal(merged[0].lunch, "계정쪽 점심");     // 원래 있던 값은 지키고
  assert.equal(merged[0].work, "자리쪽 오전");      // 빈 칸은 자리 쪽에서 채운다
  assert.equal(merged[0].afternoon, "자리쪽 오후");
  assert.equal(merged[0].present, 1);               // 한쪽이라도 출근이면 출근

  // 44) 위촉 년월 — 관리자가 조직도에서 넣는다 (실제로 일 안 하는 사람은 로그인을 안 한다)
  await api("t-super", "POST", "/admin/members", { email: "차월@x.com", name: "차월확인", teamId: 1, role: "팀원", joinedAt: "2026-05" });
  let joinRow = (await (await api("t-super", "GET", "/bootstrap")).json()).members.filter(m => m.email === "차월@x.com")[0];
  assert.equal(joinRow.joined_at, "2026-05-01");            // 년월만 보내도 저장된다
  // 보내지 않으면 그대로 둔다 (이름만 고쳐도 위촉일이 지워지지 않게)
  await api("t-super", "POST", "/admin/members", { email: "차월@x.com", name: "이름만변경" });
  joinRow = (await (await api("t-super", "GET", "/bootstrap")).json()).members.filter(m => m.email === "차월@x.com")[0];
  assert.equal(joinRow.joined_at, "2026-05-01");
  assert.equal(joinRow.name, "이름만변경");
  // 형식이 틀리면 거절
  assert.equal((await api("t-super", "POST", "/admin/members", { email: "차월@x.com", joinedAt: "2026년 5월" })).status, 400);

  // 45) 목표는 부지점장 이상만 — 관리자로 임명된 팀원도 목표는 못 정한다 (2026-08-05 사용자)
  await api("t-super", "POST", "/admin/members", { email: "fc1@x.com", name: "팀원1", teamId: 1, isManager: true });
  assert.equal((await api("t-fc1", "POST", "/perf/goals", { month: "2026-09", goals: [{ member: "팀원1", goal: "9" }] })).status, 403);
  await api("t-super", "POST", "/admin/members", { email: "fc1@x.com", name: "팀원1", teamId: 1, isManager: false });
  // 목표 건수는 CANP·도입과 따로 저장되고, 하나만 고쳐도 나머지가 남는다
  await api("t-esl1", "POST", "/perf/goals", { month: "2026-09", goals: [{ member: "팀원1", cases: 12 }] });
  const gCase = (await (await api("t-fc1", "GET", "/perf?month=2026-09")).json()).goals.find(g => g.member === "팀원1");
  assert.equal(gCase.cases, 12);
  assert.equal(gCase.goal, "1,200(120)");
  assert.equal(gCase.intro, 4);

  // 46) 권한 순서: 총관리자 > 지점장 > 수석 부지점장 > 부지점장 (2026-08-05 사용자)
  // 수석과 부지점장은 마이가디언 등급이 둘 다 ESL이라 등급으로만 비교하면 뚫린다.
  assert.equal((await api("t-esl1", "POST", "/admin/members",
    { email: "차월@x.com", role: "수석 부지점장" })).status, 403);
  assert.equal((await api("t-super", "POST", "/admin/members",
    { email: "차월@x.com", role: "수석 부지점장" })).status, 200);
  // 같은 줄(부지점장 → 부지점장)은 그대로 된다
  assert.equal((await api("t-esl1", "POST", "/admin/members",
    { email: "차월@x.com", role: "부지점장" })).status, 200);

  // 47) 사람을 내리면 그 밑 계보가 한 칸 위로 올라붙는다 — 줄기가 끊기지 않게
  await api("t-super", "POST", "/admin/members", { email: "계보중간@x.com", name: "중간", teamId: 1, role: "팀장", recruiterEmail: "esl1@x.com" });
  await api("t-super", "POST", "/admin/members", { email: "계보아래@x.com", name: "아래", teamId: 1, role: "팀원", recruiterEmail: "계보중간@x.com" });
  assert.equal((await api("t-super", "DELETE", "/admin/members/" + encodeURIComponent("계보중간@x.com"))).status, 200);
  const lifted = (await (await api("t-super", "GET", "/bootstrap")).json()).members
    .filter(m => m.email === "계보아래@x.com")[0];
  assert.equal(lifted.recruiter_email, "esl1@x.com", "도입자가 사라진 사람을 가리키면 안 된다");

  // 48) 서류함 — 합격증에는 실명·생년월일이 있다. 열람을 좁게 연다.
  const docPut = (tok, qs, body, type) => fetch(BASE + "/docs" + qs, {
    method: "POST",
    headers: { Authorization: "Bearer " + tok, "Content-Type": type || "application/pdf" },
    body
  });
  const docPdf = Buffer.from("%PDF-1.4 테스트");
  // 본인 것은 본인이 올린다
  const docOwn = await (await docPut("t-fc1", "?scope=member&kind=생명보험 합격증&name=합격증.pdf", docPdf)).json();
  assert.ok(docOwn.id);
  // 확장자·형식 검사
  assert.equal((await docPut("t-fc1", "?scope=member", docPdf, "text/html")).status, 400);
  // 남의 팀 사람 것은 못 올린다
  assert.equal((await docPut("t-esl1", "?scope=member&email=fc2@x.com", docPdf)).status, 403);
  // 팀 관리자는 자기 팀원 것을 올린다
  assert.equal((await docPut("t-esl1", "?scope=member&email=fc1@x.com&kind=손해보험 합격증", docPdf)).status, 200);
  // 지점 공용은 관리자만
  assert.equal((await docPut("t-fc1", "?scope=branch&kind=사업자등록증", docPdf)).status, 403);
  const docBiz = await (await docPut("t-super", "?scope=branch&kind=사업자등록증", docPdf)).json();
  // 열람: 다른 팀 팀원은 개인 서류를 못 보되 지점 공용은 본다
  const seenBy2 = await (await api("t-fc2", "GET", "/docs")).json();
  assert.equal(seenBy2.filter(d => d.scope === "member").length, 0, "남의 개인 서류가 보이면 안 된다");
  assert.equal(seenBy2.filter(d => d.id === docBiz.id).length, 1);
  assert.equal((await api("t-fc2", "GET", "/docs/" + docOwn.id + "/file")).status, 403);
  const docFile = await api("t-fc1", "GET", "/docs/" + docOwn.id + "/file");
  assert.equal(docFile.status, 200);
  assert.equal((await docFile.arrayBuffer()).byteLength, docPdf.length);
  // 서버 경로는 내보내지 않는다
  assert.equal((await (await api("t-fc1", "GET", "/docs")).json())[0].path, undefined);
  // 지우기도 같은 범위
  assert.equal((await api("t-fc2", "DELETE", "/docs/" + docOwn.id)).status, 403);
  assert.equal((await api("t-fc1", "DELETE", "/docs/" + docOwn.id)).status, 200);
  assert.equal((await api("t-fc1", "GET", "/docs/" + docOwn.id + "/file")).status, 403);

  // 49) 붙일 계정 목록 — 「승인 대기자」만 후보로 두면 로그인만 하고 가입 신청을
  // 안 한 사람을 영영 못 붙인다 (2026-08-05 사용자: 「연결이 안되는데」).
  const cands = await (await api("t-super", "GET", "/admin/accounts")).json();
  const candBy = Object.fromEntries(cands.map(c => [c.email, c]));
  // 하랑지점 가입 신청을 한 적 없는 계정도 후보에 있어야 한다
  assert.ok(candBy["wait@x.com"], "로그인 이력만 있어도 붙일 수 있어야 한다");
  assert.equal(candBy["fc1@x.com"].state, "명단");     // 합치기 대상은 표시가 붙는다
  assert.ok(["미신청", "대기", "명단"].includes(candBy["wait@x.com"].state));
  assert.equal((await api("t-fc1", "GET", "/admin/accounts")).status, 403);   // 관리자만

  // 50) 서류·교육 열람 범위 — 본인 / 직도입자 / 그 팀 부지점장 / 지점장
  // (2026-08-05 사용자 확정). 관리자로 임명된 팀원에게는 열지 않는다.
  await api("t-super", "POST", "/admin/members", { email: "도입된@x.com", name: "도입된사람", teamId: 1, role: "팀원", recruiterEmail: "fc1@x.com" });
  const trOwn = await (await api("t-fc1", "POST", "/trainings", { email: "도입된@x.com", name: "입과교육", doneOn: "2026-07" })).json();
  assert.ok(trOwn.id === undefined, "도입자는 보기만 한다 — 쓰기는 막힌다");
  assert.equal((await api("t-esl1", "POST", "/trainings", { email: "도입된@x.com", name: "입과교육", doneOn: "2026-07" })).status, 200);
  // 도입자는 자기가 뽑은 사람의 기록을 본다
  const seenByRecruiter = await (await api("t-fc1", "GET", "/trainings")).json();
  assert.ok(seenByRecruiter.some(t => t.member_email === "도입된@x.com"), "직도입자는 볼 수 있어야 한다");
  // 남남인 팀원에게는 안 보인다
  assert.equal((await (await api("t-fc2", "GET", "/trainings")).json()).length, 0);
  // 관리자로 임명돼도 팀원 직급이면 남의 서류는 못 본다
  await api("t-super", "POST", "/admin/members", { email: "fc2@x.com", name: "팀원2", teamId: 2, isManager: true });
  assert.equal((await (await api("t-fc2", "GET", "/trainings")).json()).length, 0, "관리자 임명은 서류 열람 근거가 아니다");
  await api("t-super", "POST", "/admin/members", { email: "fc2@x.com", name: "팀원2", teamId: 2, isManager: false });
  // 이수일 형식 검사
  assert.equal((await api("t-esl1", "POST", "/trainings", { email: "도입된@x.com", name: "GROW", doneOn: "7월" })).status, 400);
  // 본인은 자기 것을 쓴다
  const trMine = await (await api("t-fc1", "POST", "/trainings", { name: "온라인 교육", doneOn: "2026-08-01" })).json();
  assert.ok(trMine.id);
  // 지우고 다시 넣지 않고 그 자리에서 고친다 (2026-08-05 사용자)
  assert.equal((await api("t-fc1", "POST", "/trainings/" + trMine.id, { name: "10차월 교육", doneOn: "2026-08-02" })).status, 200);
  const trAfter = (await (await api("t-fc1", "GET", "/trainings")).json()).find(x => x.id === trMine.id);
  assert.equal(trAfter.name, "10차월 교육");
  assert.equal(trAfter.done_on, "2026-08-02");
  // 남이 고치는 것은 막는다
  assert.equal((await api("t-fc2", "POST", "/trainings/" + trMine.id, { name: "가로채기" })).status, 403);
  // 날짜만 비우는 것도 된다 (모르면 비워 두는 게 기록을 남기는 길이다)
  assert.equal((await api("t-fc1", "POST", "/trainings/" + trMine.id, { doneOn: "" })).status, 200);
  assert.equal((await (await api("t-fc1", "GET", "/trainings")).json()).find(x => x.id === trMine.id).done_on, "");

  // ── 51) 코덱스 반대심문(2026-08-05)에서 나온 구멍들 ──

  // 51-1) 팀 없는 사람의 개인 서류가 모든 부지점장에게 열리던 문제.
  // canSeeTeam(user, null)은 지점 공통 공지용이라 전원 통과다 — 개인 자료에 쓰면 안 된다.
  await api("t-super", "POST", "/admin/members", { email: "무소속@x.com", name: "무소속", teamId: null, role: "팀원" });
  await api("t-super", "POST", "/trainings", { email: "무소속@x.com", name: "입과교육", doneOn: "2026-06-01" });
  const esl1Sees = await (await api("t-esl1", "GET", "/trainings")).json();
  assert.ok(!esl1Sees.some(t => t.member_email === "무소속@x.com"),
    "팀 없는 사람 자료가 남의 팀 부지점장에게 보이면 안 된다");
  assert.ok((await (await api("t-super", "GET", "/trainings")).json()).some(t => t.member_email === "무소속@x.com"),
    "총관리자는 본다");

  // 51-2) 팀을 옮기면 옛 팀 부지점장은 손을 뗀다 (기록의 team_id는 만들 때의 스냅숏이다)
  await api("t-super", "POST", "/admin/members", { email: "이사간@x.com", name: "이사간", teamId: 1, role: "팀원" });
  const trMoved = await (await api("t-esl1", "POST", "/trainings", { email: "이사간@x.com", name: "GROW" })).json();
  assert.ok(trMoved.id);
  await api("t-super", "POST", "/admin/members", { email: "이사간@x.com", teamId: 2 });
  assert.equal((await api("t-esl1", "POST", "/trainings/" + trMoved.id, { name: "가로채기" })).status, 403,
    "옛 팀 부지점장은 더 이상 못 고친다");
  assert.ok(!(await (await api("t-esl1", "GET", "/trainings")).json()).some(t => t.id === trMoved.id),
    "옛 팀 부지점장에게 더 이상 보이지 않는다");

  // 51-3) 승인 경로가 직급 상승 차단을 우회하던 문제 — 부지점장이 지점장을 만들 수 있었다
  await api("t-up", "POST", "/join", { name: "승급시도" });
  assert.equal((await api("t-esl1", "POST", "/pending/approve", { email: "up@x.com", teamId: 1, role: "지점장" })).status, 403);
  assert.equal((await api("t-esl1", "POST", "/pending/approve", { email: "up@x.com", teamId: 1, role: "팀원" })).status, 200);

  // 51-4) 헤더만 PDF라고 써 보내면 거절한다 (내용 앞머리를 본다)
  assert.equal((await docPut("t-fc1", "?scope=member&name=가짜.pdf", Buffer.from("<html>hi</html>"))).status, 400);
  assert.equal((await docPut("t-fc1", "?scope=member&name=진짜.pdf", Buffer.from("%PDF-1.4 진짜"))).status, 200);

  // 51-5) 목록에 서버 경로·업로더 이메일이 새지 않는다
  const docList = await (await api("t-fc1", "GET", "/docs")).json();
  assert.ok(docList.length);
  assert.equal(docList[0].path, undefined);
  assert.equal(docList[0].uploader, undefined);

  // 51-6) 도입자 고리 — 화면이 아니라 서버가 막는다
  await api("t-super", "POST", "/admin/members", { email: "고리A@x.com", name: "고리A", teamId: 1, role: "팀원" });
  await api("t-super", "POST", "/admin/members", { email: "고리B@x.com", name: "고리B", teamId: 1, role: "팀원", recruiterEmail: "고리A@x.com" });
  assert.equal((await api("t-super", "POST", "/admin/members", { email: "고리A@x.com", recruiterEmail: "고리A@x.com" })).status, 400);
  assert.equal((await api("t-super", "POST", "/admin/members", { email: "고리A@x.com", recruiterEmail: "고리B@x.com" })).status, 400);
  assert.equal((await api("t-super", "POST", "/admin/members", { email: "고리A@x.com", recruiterEmail: "없는사람@x.com" })).status, 404);

  // 51-7) 목표 대상은 그 팀 사람이어야 한다
  assert.equal((await api("t-esl1", "POST", "/perf/goals", { teamId: 1, month: "2026-11",
    goals: [{ member: "팀원2", memberEmail: "fc2@x.com", cases: 999 }] })).status, 400);

  // 51-8) 서류·교육이 있는 사람은 명단에서 내려도 기록이 살아 있다 (통째로 지우지 않는다)
  await api("t-super", "POST", "/admin/members", { email: "서류맨@x.com", name: "서류맨", teamId: 1, role: "팀원" });
  await api("t-super", "POST", "/trainings", { email: "서류맨@x.com", name: "입과교육" });
  assert.equal((await api("t-super", "DELETE", "/admin/members/" + encodeURIComponent("서류맨@x.com"))).status, 200);
  const stillThere = (await (await api("t-super", "GET", "/bootstrap")).json()).members
    .filter(m => m.email === "서류맨@x.com")[0];
  assert.ok(stillThere && stillThere.active === 0, "기록이 있으면 지우지 않고 내린다");

  console.log("전체 통과 — 인증·팀 분리·쓰기 권한·소유권·멱등키·부분갱신·초대승인·조직도수정·날짜검증·월복사·TA개인정보·KST·동명이인·조직도직급·내정보·생일·TA잠금·보관기간·반복일정·도입현황·계정연결·조직도순서·지난보고·목표보존·일괄저장·명단내리기·미션분모·요일복사·일정세부·대상이관·잠금시도제한·직급상승차단·전체열람쓰기차단·달력날짜·목표동명이인·출석병합·위촉년월 확인 완료");
}

main().catch(e => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    // 윈도우는 프로세스가 살아 있는 동안 DB 파일을 지울 수 없다 — 종료를 기다린다
    const exited = new Promise(r => srv.on("exit", r));
    srv.kill();
    await exited;
    for (const f of [AUTH, DATA, DATA + "-wal", DATA + "-shm"])
      try { rmSync(f, { force: true }); } catch { /* WAL 잔재는 다음 실행이 지운다 */ }
    try { rmSync(FILES, { force: true, recursive: true }); } catch { /* 다음 실행이 지운다 */ }
  });
