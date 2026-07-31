// 마이가디언 세션 공유 — 인증 브리지
//
// 원칙: 팀원이 프로그램마다 따로 승인받게 하지 않는다. 로그인·승인·직급은 전부
// 마이가디언 서버 소관이고, 여기서는 그 DB(myguardian.db)를 읽기만 한다.
// 같은 NCP 인스턴스에서 돌므로 파일 경로로 연다. 쓰기는 절대 하지 않는다.

import { DatabaseSync } from "node:sqlite";

export function openAuthDb(file) {
  return new DatabaseSync(file, { readOnly: true });
}

// 세션 토큰 → 승인된 계정. 만료·정지·미승인은 전부 null (차단은 서버가 한다).
export function accountForToken(authDb, token) {
  if (!token) return null;
  const row = authDb.prepare(
    `SELECT a.id, a.email, a.name, a.status, a.grade, a.is_admin, s.expires_at
     FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token = ?`
  ).get(token);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  if (row.status !== "승인") return null;
  return row;
}
