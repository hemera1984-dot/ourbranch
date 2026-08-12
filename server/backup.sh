#!/usr/bin/env bash
# 백업 — 매일 새벽에 돌린다 (cron). 하랑지점 + 마이가디언 DB, 그리고 서류 파일.
#
# 설치: bash backup.sh --install   (root)
# 수동: bash backup.sh
#
# SQLite는 WAL 모드라 파일을 그냥 복사하면 깨질 수 있다. .backup 명령으로 뜬다.
# 보관: 최근 14일 + 매월 1일본은 따로 남긴다.

set -euo pipefail

DEST=/var/backups/ourbranch
STATUS=/var/lib/ourbranch/backup-status.json

# 중간에 죽어도 상태는 남긴다 — 안 남기면 지난번 성공이 그대로 남아
# 백업이 멈춘 것을 최대 하루 반 동안 모른다.
write_status() {
  local ok=$1
  mkdir -p "$(dirname "$STATUS")" 2>/dev/null || true
  printf '{"시각":"%s","성공":%s,"개수":%s,"서류묶음":%s,"용량":"%s"}
'     "$(date -Iseconds)" "$ok"     "$(ls -1 "$DEST"/*.db.gz 2>/dev/null | wc -l)"     "$(ls -1 "$DEST"/files-*.tar.gz 2>/dev/null | wc -l)"     "$(du -sh "$DEST" 2>/dev/null | cut -f1)" > "$STATUS"
  chown myguardian:myguardian "$STATUS" 2>/dev/null || true
}
trap 'write_status false' ERR
KEEP_DAYS=14
DBS=("/var/lib/ourbranch/ourbranch.db" "/var/lib/myguardian/myguardian.db")
# 서류 파일 — 합격증·수료증. DB에는 「어디 있는지」만 있어서 파일이 날아가면 못 되살린다.
# 경로는 서버가 실제로 쓰는 값(.env의 FILE_DIR)에서 읽는다. 여기 박아 두면
# 서버가 다른 볼륨으로 옮겨간 뒤에도 옛 폴더를 뜨고 「성공」이라 적는다 (코덱스 검증).
ENV_FILE=/opt/ourbranch/server/.env
FILES_DIR=$(grep -s '^FILE_DIR=' "$ENV_FILE" | tail -1 | cut -d= -f2-)
FILES_DIR=${FILES_DIR:-/var/lib/ourbranch/files}

if [ "${1:-}" = "--install" ]; then
  install -m 755 "$0" /usr/local/bin/ourbranch-backup
  cat > /etc/cron.d/ourbranch-backup <<'CRON'
# 하랑지점·마이가디언 DB 백업 — 매일 새벽 4시 10분
10 4 * * * root /usr/local/bin/ourbranch-backup >> /var/log/ourbranch-backup.log 2>&1
CRON
  echo "설치 완료 — 매일 04:10 백업. 로그: /var/log/ourbranch-backup.log"
  exit 0
fi

mkdir -p "$DEST"
FAILED=0
STAMP=$(date +%Y%m%d)
DAY=$(date +%d)

for SRC in "${DBS[@]}"; do
  # 경로가 바뀌거나 파일이 사라진 것은 「건너뛸 일」이 아니라 실패다.
  # 조용히 넘기면 백업이 없는데도 정상으로 보인다.
  if [ ! -f "$SRC" ]; then
    echo "$(date '+%F %T') 백업 대상 없음: $SRC"
    FAILED=1
    continue
  fi
  NAME=$(basename "$SRC" .db)
  OUT="$DEST/${NAME}-${STAMP}.db"
  # WAL 안전 복사 — sqlite3가 없으면 node 내장 sqlite로 대신한다
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$SRC" ".backup '$OUT'"
  else
    node -e "
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1], { readOnly: true });
      db.exec(\"VACUUM INTO '\" + process.argv[2] + \"'\");
      db.close();
    " "$SRC" "$OUT"
  fi
  # 뜬 파일이 실제로 열리는지 확인한다 — 깨진 백업은 없는 백업보다 나쁘다
  node -e "
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(process.argv[1], { readOnly: true });
    const chk = d.prepare('PRAGMA integrity_check').get();
    const v = Object.values(chk)[0];
    if (v !== 'ok') { console.error('무결성 실패: ' + v); process.exit(1); }
    const n = d.prepare(\"SELECT COUNT(*) n FROM sqlite_master WHERE type='table'\").get().n;
    if (!n) { console.error('테이블이 없다'); process.exit(1); }
    d.close();
  " "$OUT" || { echo "$(date '+%F %T') 백업 검증 실패: ${NAME}"; FAILED=1; continue; }
  gzip -f "$OUT"
  # 매월 1일본은 월별 보관함에 따로 (장기 보관)
  if [ "$DAY" = "01" ]; then
    mkdir -p "$DEST/monthly"
    cp "$OUT.gz" "$DEST/monthly/${NAME}-${STAMP}.db.gz"
  fi
  echo "$(date '+%F %T') 백업 완료: ${NAME} → $(du -h "$OUT.gz" | cut -f1)"
done

# ── 서류 파일 ──
# DB만 떠 두면 「합격증이 있다」는 기록만 남고 파일은 사라진다.
# 파일은 한 번 올라오면 바뀌지 않으므로, 지난 묶음보다 새 파일이 있을 때만 다시 뜬다.
DOC_ROWS=$(node -e "
  const { DatabaseSync } = require('node:sqlite');
  try {
    const d = new DatabaseSync(process.argv[1], { readOnly: true });
    process.stdout.write(String(d.prepare('SELECT COUNT(*) n FROM docs').get().n));
    d.close();
  } catch { process.stdout.write('0'); }
" "/var/lib/ourbranch/ourbranch.db" 2>/dev/null || echo 0)

if [ ! -d "$FILES_DIR" ]; then
  # DB에 서류가 있는데 폴더가 없으면 「올린 서류가 없다」가 아니라 사고다
  if [ "$DOC_ROWS" != "0" ]; then
    echo "$(date '+%F %T') 서류 $DOC_ROWS건이 있는데 폴더가 없다: $FILES_DIR"
    FAILED=1
  else
    echo "$(date '+%F %T') 서류 폴더 없음: $FILES_DIR (아직 올린 서류가 없으면 정상)"
  fi
elif true; then
  FOUT="$DEST/files-${STAMP}.tar.gz"
  LAST=$(ls -1t "$DEST"/files-*.tar.gz 2>/dev/null | head -1 || true)
  # find가 권한·I/O로 죽으면 출력이 비어 「변경 없음」으로 둔갑한다. 종료 코드를 따로 본다.
  NEWER=""
  SKIP=0
  if [ -n "$LAST" ]; then
    if NEWER=$(find "$FILES_DIR" -newer "$LAST" -type f -print -quit 2>/dev/null); then
      [ -z "$NEWER" ] && SKIP=1
    else
      echo "$(date '+%F %T') 서류 변경 확인 실패 — 그냥 새로 묶는다"
    fi
  fi
  if [ "$SKIP" = "1" ]; then
    echo "$(date '+%F %T') 서류 변경 없음 — 지난 묶음 유지: $(basename "$LAST")"
    # 매월 1일에는 변경이 없어도 장기 보관본을 남긴다.
    # 안 남기면 월별 DB만 있고 그 시점 파일이 없어 복구가 반쪽이 된다.
    if [ "$DAY" = "01" ]; then
      mkdir -p "$DEST/monthly"
      cp "$LAST" "$DEST/monthly/files-${STAMP}.tar.gz"
      echo "$(date '+%F %T') 월별 보관에 지난 묶음 복사"
    fi
  else
    tar -czf "$FOUT" -C "$(dirname "$FILES_DIR")" "$(basename "$FILES_DIR")" \
      || { echo "$(date '+%F %T') 서류 백업 실패"; FAILED=1; }
    # 묶음이 실제로 풀리는지 확인한다 — 깨진 백업은 없는 백업보다 나쁘다
    if [ -f "$FOUT" ]; then
      tar -tzf "$FOUT" >/dev/null 2>&1 \
        || { echo "$(date '+%F %T') 서류 백업 검증 실패"; rm -f "$FOUT"; FAILED=1; }
    fi
    [ -f "$FOUT" ] && echo "$(date '+%F %T') 서류 백업 완료 → $(du -h "$FOUT" | cut -f1)"
    if [ "$DAY" = "01" ] && [ -f "$FOUT" ]; then
      mkdir -p "$DEST/monthly"
      cp "$FOUT" "$DEST/monthly/files-${STAMP}.tar.gz"
    fi
  fi
fi

# 오래된 일별 백업 정리 (월별 보관함은 건드리지 않는다)
find "$DEST" -maxdepth 1 -name '*.db.gz' -mtime +$KEEP_DAYS -delete
find "$DEST" -maxdepth 1 -name 'files-*.tar.gz' -mtime +$KEEP_DAYS -delete
echo "$(date '+%F %T') 보관 중: $(ls -1 "$DEST"/*.db.gz 2>/dev/null | wc -l)개"

# 결과를 파일로 남긴다 — 앱이 읽어서 총관리자에게 보여준다.
# (알림은 앱 안에서만 한다는 원칙이라 메일·문자를 쓰지 않는다)
write_status $([ "$FAILED" = "0" ] && echo true || echo false)

# 남은 일: 외부 저장소 복사. 서버·디스크가 통째로 나가면 여기 백업도 같이 사라진다.
# NCP 오브젝트 스토리지 자격증명을 받으면 이 자리에 s3 동기화를 넣는다.
# (자격증명은 채팅에 붙여넣지 않고 /etc/ourbranch-backup.env 로 전달)

[ "$FAILED" = "0" ] || exit 1
