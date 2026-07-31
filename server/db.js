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

    -- 계정과의 연결 고리는 이메일 (마이가디언 accounts.email 소문자 기준).
    -- is_manager: 관리자(팀원 추가·삭제, 조직도 수정). 부지점장 이상 기본, 총관리자가 토글.
    -- can_view_all: 자기 팀 밖 열람 (총관리자가 승인한 부지점장용).
    CREATE TABLE IF NOT EXISTS members (
      email        TEXT PRIMARY KEY,
      name         TEXT NOT NULL DEFAULT '',
      team_id      INTEGER REFERENCES teams(id),
      role         TEXT NOT NULL DEFAULT '팀원',
      is_manager   INTEGER NOT NULL DEFAULT 0,
      can_view_all INTEGER NOT NULL DEFAULT 0
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
      customer_code TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);

    -- 출근·Aitom 자가 보고 (하루 한 줄)
    CREATE TABLE IF NOT EXISTS attendance (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      email   TEXT NOT NULL,
      date    TEXT NOT NULL,
      present INTEGER NOT NULL DEFAULT 0,
      reason  TEXT NOT NULL DEFAULT '',
      aitom   INTEGER NOT NULL DEFAULT 0,
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

    -- 팀원별 월 목표 (시트의 "목표 1,000(100)" 줄)
    CREATE TABLE IF NOT EXISTS perf_goals (
      team_id INTEGER NOT NULL REFERENCES teams(id),
      month   TEXT NOT NULL,
      member  TEXT NOT NULL,
      goal    TEXT NOT NULL DEFAULT '',
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
  `);
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
