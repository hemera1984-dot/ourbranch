// 하랑지점(ourbranch) 데이터 저장소 — Node 내장 SQLite (외부 패키지 없음)
//
// 인증은 이 DB가 아니라 마이가디언 DB(auth.js)가 담당한다. 여기는 지점 데이터만:
// 팀·소속·공지·일정·출근·과제. 규모는 지점 30명 남짓 — 파일 하나면 충분하다.
// ponytail: 단일 파일 SQLite. 지점이 여러 개가 되면 branch 컬럼을 추가해 가른다.

import { DatabaseSync } from "node:sqlite";

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS teams (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    -- 초대 — 누구나 만들 수 있다(카톡으로 링크 전달). 초대 자체는 권한을 주지 않고,
    -- 링크로 들어온 사람은 '대기' 상태로 줄을 서고 승인권자가 승인해야 열린다.
    CREATE TABLE IF NOT EXISTS invites (
      code       TEXT PRIMARY KEY,
      team_id    INTEGER REFERENCES teams(id),
      role       TEXT NOT NULL DEFAULT '팀원',
      by_email   TEXT NOT NULL,
      by_name    TEXT NOT NULL DEFAULT '',
      created    TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    -- 가입 신청 — 구글 로그인만 끝낸 사람. 승인되면 members로 옮겨진다.
    CREATE TABLE IF NOT EXISTS pending (
      email       TEXT PRIMARY KEY,
      name        TEXT NOT NULL DEFAULT '',
      team_id     INTEGER REFERENCES teams(id),
      role        TEXT NOT NULL DEFAULT '팀원',
      invite_code TEXT,
      by_name     TEXT NOT NULL DEFAULT '',
      created     TEXT NOT NULL
    );

    -- 계정과의 연결 고리는 이메일 (마이가디언 accounts.email 소문자 기준).
    -- is_manager: 관리자(팀원 추가·삭제, 조직도 수정). 부지점장 이상 기본, 총관리자가 토글.
    -- can_view_all: 자기 팀 밖 열람 (총관리자가 승인한 부지점장용).
    -- recruiter_email: 도입자(이 사람을 뽑은 사람). 도입자는 팀이 달라도
    -- 자기가 도입한 팀원의 일정을 열람할 수 있다 (2026-07-31 일정 원칙).
    CREATE TABLE IF NOT EXISTS members (
      email           TEXT PRIMARY KEY,
      name            TEXT NOT NULL DEFAULT '',
      team_id         INTEGER REFERENCES teams(id),
      role            TEXT NOT NULL DEFAULT '팀원',
      is_manager      INTEGER NOT NULL DEFAULT 0,
      can_view_all    INTEGER NOT NULL DEFAULT 0,
      recruiter_email TEXT
    );

    -- team_id가 NULL이면 지점 공통 공지 (전원 열람)
    CREATE TABLE IF NOT EXISTS notices (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER REFERENCES teams(id),
      kind    TEXT NOT NULL DEFAULT '공지',
      title   TEXT NOT NULL,
      body    TEXT NOT NULL DEFAULT '[]',
      author  TEXT NOT NULL,
      created TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS comments (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      notice_id INTEGER NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
      author    TEXT NOT NULL,
      content   TEXT NOT NULL,
      created   TEXT NOT NULL
    );

    -- 공지 확인 — 댓글 대신 버튼 한 번 (2026-08-01 사용자: 일일이 댓글 다는 건 빡시다)
    CREATE TABLE IF NOT EXISTS notice_reads (
      notice_id INTEGER NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
      email     TEXT NOT NULL,
      name      TEXT NOT NULL DEFAULT '',
      created   TEXT NOT NULL,
      PRIMARY KEY (notice_id, email)
    );

    -- member_email이 NULL이면 팀 공유 일정, 있으면 개인 일정 칸.
    -- team_id NULL은 지점 직속(지점장 등 팀 무소속)의 일정 — 전원 열람.
    -- source/source_key/status/customer_code: 마이가디언 고객미팅 연동
    -- (docs/myguardian-schedule-interop.md 계약. 고객은 코드만, 실명 금지.)
    CREATE TABLE IF NOT EXISTS events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id       INTEGER REFERENCES teams(id),
      member_email  TEXT,
      date          TEXT NOT NULL,
      start         TEXT,
      end           TEXT,
      kind          TEXT NOT NULL DEFAULT '기타',
      title         TEXT NOT NULL DEFAULT '',
      source        TEXT,
      source_key    TEXT UNIQUE,
      status        TEXT NOT NULL DEFAULT '예정',
      customer_code TEXT NOT NULL DEFAULT '',
      place         TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);

    -- 강의 신청 — 지점 전체 일정(강의)에 팀 무관 신청 (2026-08-01)
    CREATE TABLE IF NOT EXISTS event_attendees (
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      email    TEXT NOT NULL,
      name     TEXT NOT NULL DEFAULT '',
      created  TEXT NOT NULL,
      PRIMARY KEY (event_id, email)
    );

    -- 출석·하루 상태 (하루 한 줄) — 실물 스케줄표의 출근일정·점심일정 칸 +
    -- 카톡 일일보고 항목(오전·점심·오후·특이사항)을 한 줄에 담는다.
    -- work = 오전 활동, afternoon = 오후 활동, note = 특이사항/요청사항
    -- checked_at: 출석 체크를 누른 시각 (한 번 찍히면 유지)
    CREATE TABLE IF NOT EXISTS attendance (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      email      TEXT NOT NULL,
      date       TEXT NOT NULL,
      present    INTEGER NOT NULL DEFAULT 0,
      reason     TEXT NOT NULL DEFAULT '',
      aitom      INTEGER NOT NULL DEFAULT 0,
      work       TEXT NOT NULL DEFAULT '',
      lunch      TEXT NOT NULL DEFAULT '',
      afternoon  TEXT NOT NULL DEFAULT '',
      note       TEXT NOT NULL DEFAULT '',
      checked_at TEXT,
      UNIQUE(email, date)
    );

    -- TA 일지 — 실물 시트(TA일지 미래4팀/하랑1팀) 열 구조 그대로.
    -- 후보자 개인정보(이름·번호·주소)는 서버에만 두고 저장소·외부 산출물에는 마스킹.
    CREATE TABLE IF NOT EXISTS ta_logs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id      INTEGER NOT NULL REFERENCES teams(id),
      author       TEXT NOT NULL,
      date         TEXT NOT NULL,
      cand_name    TEXT NOT NULL DEFAULT '',
      gender       TEXT NOT NULL DEFAULT '',
      age          TEXT NOT NULL DEFAULT '',
      region       TEXT NOT NULL DEFAULT '',
      safe_phone   TEXT NOT NULL DEFAULT '',
      real_phone   TEXT NOT NULL DEFAULT '',
      result       TEXT NOT NULL DEFAULT '',
      reject_sms   TEXT NOT NULL DEFAULT '',
      cis_sms      TEXT NOT NULL DEFAULT '',
      note         TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_ta_team_date ON ta_logs(team_id, date);

    -- 업적현황 — 실물 시트(팀 업적) 구조: 팀원별 계약 한 줄(계약일·월납·CANP), 월 단위 집계.
    -- 팀원은 계정이 없을 수 있어(신인) 이름 문자열로 둔다.
    CREATE TABLE IF NOT EXISTS perf (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id       INTEGER NOT NULL REFERENCES teams(id),
      month         TEXT NOT NULL,
      member        TEXT NOT NULL,
      contract_date TEXT NOT NULL DEFAULT '',
      premium       REAL NOT NULL DEFAULT 0,
      canp          REAL NOT NULL DEFAULT 0,
      note          TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_perf_team_month ON perf(team_id, month);

    -- 팀원별 월 목표·도입 실적 (시트의 "목표 1,000(100) 도입4명" 줄)
    CREATE TABLE IF NOT EXISTS perf_goals (
      team_id INTEGER NOT NULL REFERENCES teams(id),
      month   TEXT NOT NULL,
      member  TEXT NOT NULL,
      goal    TEXT NOT NULL DEFAULT '',
      intro   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (team_id, month, member)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id  INTEGER NOT NULL REFERENCES teams(id),
      title    TEXT NOT NULL,
      content  TEXT NOT NULL DEFAULT '',
      targets  TEXT NOT NULL DEFAULT '"전체"',
      status   TEXT NOT NULL DEFAULT '요청',
      assigned TEXT NOT NULL,
      due      TEXT
    );

    -- 동명이인 대비: 소유권은 이름이 아니라 이메일로 판정한다.
    -- author·member(이름)는 표시용으로 남기고, *_email이 실제 주인이다.
    -- (이름만 쓰면 동명이인이 서로의 기록을 수정하고, 개명하면 과거 기록을 잃는다)

    -- 미션 달성 체크 — 개인별. 팀 미션(전체)은 달성 인원/전체 인원으로 퍼센트 산출
    -- TA 일지 잠금 — 지점 공용 비밀번호를 푼 사람과 만료 시각 (서버 재시작에도 유지)
    CREATE TABLE IF NOT EXISTS ta_unlock (
      email TEXT PRIMARY KEY,
      until TEXT NOT NULL
    );

    -- 열람 기록 — 후보자 실명·연락처가 든 일지를 누가 언제 열었는지 남긴다.
    -- 민원이 들어왔을 때 이 기록이 없으면 아무것도 확인할 수 없다.
    CREATE TABLE IF NOT EXISTS ta_access (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      email   TEXT NOT NULL,
      name    TEXT NOT NULL DEFAULT '',
      created TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_done (
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      email   TEXT NOT NULL,
      name    TEXT NOT NULL DEFAULT '',
      created TEXT NOT NULL,
      PRIMARY KEY (task_id, email)
    );
  `);

  // 이미 만들어진 DB에 컬럼 추가 (있으면 실패하므로 삼킨다 — 마이가디언 방식)
  for (const sql of [
    "ALTER TABLE members ADD COLUMN recruiter_email TEXT",
    "ALTER TABLE events ADD COLUMN place TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE perf_goals ADD COLUMN intro INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE attendance ADD COLUMN work TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE attendance ADD COLUMN lunch TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE attendance ADD COLUMN checked_at TEXT",
    "ALTER TABLE attendance ADD COLUMN afternoon TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE attendance ADD COLUMN note TEXT NOT NULL DEFAULT ''",
    // 동명이인 구분 — 소유자를 이메일로 못박는다
    "ALTER TABLE ta_logs ADD COLUMN author_email TEXT",
    "ALTER TABLE perf ADD COLUMN member_email TEXT",
    "ALTER TABLE perf_goals ADD COLUMN member_email TEXT",
    // 본인 확인 — 구글 계정 이름이 그대로 들어오면 "kim jia"처럼 남는다.
    // 승인 후 본인이 실명을 확인해야 1이 된다.
    "ALTER TABLE members ADD COLUMN phone TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE members ADD COLUMN profile_done INTEGER NOT NULL DEFAULT 0",
    // 생일은 MM-DD만 둔다 (연도를 받으면 나이가 지점 전체에 공개된다)
    "ALTER TABLE members ADD COLUMN birthday TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE members ADD COLUMN joined_at TEXT NOT NULL DEFAULT ''",
    // TA 일지 주의 표시 — 알바몬 등에서 걸러야 할 상대를 지점 전체가 공유한다
    "ALTER TABLE ta_logs ADD COLUMN flag TEXT NOT NULL DEFAULT ''",
    // 도입 단계 — 통화 → 면접 → 위촉. 어디서 끊기는지 봐야 도입이 는다.
    "ALTER TABLE ta_logs ADD COLUMN stage TEXT NOT NULL DEFAULT ''"
  ]) { try { db.exec(sql); } catch { /* 이미 있음 */ } }

  // 기존 기록에 이메일 채우기 — 이름이 유일한 사람만 (동명이인은 사람이 판단해야 한다)
  try {
    db.exec(`
      UPDATE ta_logs SET author_email = (
        SELECT m.email FROM members m WHERE m.name = ta_logs.author
        AND (SELECT COUNT(*) FROM members m2 WHERE m2.name = ta_logs.author) = 1
      ) WHERE author_email IS NULL;
      UPDATE perf SET member_email = (
        SELECT m.email FROM members m WHERE m.name = perf.member
        AND (SELECT COUNT(*) FROM members m2 WHERE m2.name = perf.member) = 1
      ) WHERE member_email IS NULL;
      UPDATE perf_goals SET member_email = (
        SELECT m.email FROM members m WHERE m.name = perf_goals.member
        AND (SELECT COUNT(*) FROM members m2 WHERE m2.name = perf_goals.member) = 1
      ) WHERE member_email IS NULL;
    `);
  } catch (e) { /* 최초 생성 시엔 대상이 없다 */ }

  return db;
}

export const getSetting = (db, key) =>
  (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) || {}).value ?? null;

export function setSetting(db, key, value) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

export const getMember = (db, email) =>
  db.prepare("SELECT * FROM members WHERE email = ?").get(email.toLowerCase()) || null;
