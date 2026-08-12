// 마이가디언 세션 공유 — 인증 브리지
//
// 원칙: 팀원이 프로그램마다 따로 승인받게 하지 않는다. 로그인·승인·직급은 전부
// 마이가디언 서버 소관이고, 여기서는 그 DB(myguardian.db)를 읽기만 한다.
// 같은 NCP 인스턴스에서 돌므로 파일 경로로 연다. 쓰기는 절대 하지 않는다.

import { DatabaseSync } from "node:sqlite";

export function openAuthDb(file) {
  return new DatabaseSync(file, { readOnly: true });
}

// 자리에 붙일 수 있는 계정 — 마이가디언에 실제로 로그인한 적이 있는 사람.
// 이름·이메일만 돌려준다(직급·권한은 하랑지점이 따로 정한다).
export function listAccounts(authDb) {
  return authDb.prepare(
    `SELECT email, COALESCE(NULLIF(display_name, ''), name) AS name, status
     FROM accounts WHERE status <> '정지' ORDER BY name, email`
  ).all();
}

// 세션 토큰 → 계정. 만료·정지는 null.
//
// 마이가디언에서 아직 '대기'인 계정도 통과시킨다 — 하랑지점은 자체 승인 체계를
// 갖고 있어서, 마이가디언 승인을 기다리지 않고 우리 승인 대기열로 받아야 한다.
// (구글 로그인 자체는 마이가디언이 이미 검증했으므로 신원은 확실하다.)
// 실제 접근 허용은 server.js가 하랑지점 명단(members)으로 판정한다.
export function accountForToken(authDb, token) {
  if (!token) return null;
  const row = authDb.prepare(
    `SELECT a.id, a.email, a.name, a.status, a.grade, a.is_admin, s.expires_at
     FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token = ?`
  ).get(token);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  if (row.status === "정지") return null;
  return row;
}
