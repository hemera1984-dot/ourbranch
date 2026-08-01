#!/usr/bin/env bash
# DB 백업 — 매일 새벽에 돌린다 (cron). 하랑지점 + 마이가디언 DB를 함께 지킨다.
#
# 설치: bash backup.sh --install   (root)
# 수동: bash backup.sh
#
# SQLite는 WAL 모드라 파일을 그냥 복사하면 깨질 수 있다. .backup 명령으로 뜬다.
# 보관: 최근 14일 + 매월 1일본은 따로 남긴다.

set -euo pipefail

DEST=/var/backups/ourbranch
KEEP_DAYS=14
DBS=("/var/lib/ourbranch/ourbranch.db" "/var/lib/myguardian/myguardian.db")

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
STAMP=$(date +%Y%m%d)
DAY=$(date +%d)

for SRC in "${DBS[@]}"; do
  [ -f "$SRC" ] || continue
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
  gzip -f "$OUT"
  # 매월 1일본은 월별 보관함에 따로 (장기 보관)
  if [ "$DAY" = "01" ]; then
    mkdir -p "$DEST/monthly"
    cp "$OUT.gz" "$DEST/monthly/${NAME}-${STAMP}.db.gz"
  fi
  echo "$(date '+%F %T') 백업 완료: ${NAME} → $(du -h "$OUT.gz" | cut -f1)"
done

# 오래된 일별 백업 정리 (월별 보관함은 건드리지 않는다)
find "$DEST" -maxdepth 1 -name '*.db.gz' -mtime +$KEEP_DAYS -delete
echo "$(date '+%F %T') 보관 중: $(ls -1 "$DEST"/*.db.gz 2>/dev/null | wc -l)개"
