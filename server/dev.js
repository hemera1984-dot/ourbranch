// 개발 실행 — 임시 인증 DB(총관리자·부지점장·팀원)를 만들고 web/까지 서빙한다.
// 실행: node dev.js  →  http://localhost:8788/?token=dev-super
// 실데이터가 아니라 개발 확인용 계정이다. dev-*.db는 저장소에 커밋하지 않는다.

import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";

process.chdir(import.meta.dirname);   // 어디서 실행해도 server/ 기준

const AUTH = "./dev-auth.db";

rmSync(AUTH, { force: true });
const auth = new DatabaseSync(AUTH);
auth.exec(`
  CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT, name TEXT, status TEXT, grade TEXT, is_admin INTEGER);
  CREATE TABLE sessions (token TEXT PRIMARY KEY, account_id INTEGER, expires_at TEXT);
`);
const far = new Date(Date.now() + 30 * 86400e3).toISOString();
const acc = auth.prepare("INSERT INTO accounts (id, email, name, status, grade, is_admin) VALUES (?, ?, ?, ?, ?, ?)");
acc.run(1, "super@dev.local", "안창민", "승인", "SSL", 1);
acc.run(2, "esl@dev.local", "부지점장", "승인", "ESL", 0);
acc.run(3, "fc@dev.local", "팀원한명", "승인", "FC", 0);
acc.run(4, "new@dev.local", "신입사원", "승인", "FC", 0);   // 명단 미등록 — 초대 흐름 확인용
const ses = auth.prepare("INSERT INTO sessions (token, account_id, expires_at) VALUES (?, ?, ?)");
ses.run("dev-super", 1, far);
ses.run("dev-esl", 2, far);
ses.run("dev-fc", 3, far);
ses.run("dev-new", 4, far);
auth.close();

process.env.AUTH_DB_FILE = AUTH;
process.env.DB_FILE = process.env.DB_FILE || "./dev-data.db";
process.env.WEB_DIR = join(import.meta.dirname, "..", "web");

// 지점명은 코드에 박지 않는다 — 설정값. 개발 DB에도 같은 방식으로 넣는다.
{
  const { openDb, setSetting } = await import("./db.js");
  const d = openDb(process.env.DB_FILE);
  setSetting(d, "지점명", "하랑지점");
  d.close();
}

console.log("개발 토큰: dev-super(총관리자) / dev-esl(부지점장) / dev-fc(팀원) / dev-new(미등록)");
console.log("접속: http://localhost:8788/?token=dev-super");
await import("./server.js");
