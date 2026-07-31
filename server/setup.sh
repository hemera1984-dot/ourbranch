#!/usr/bin/env bash
# 하랑지점(ourbranch) 서버 설치 — 마이가디언이 이미 돌고 있는 NCP 서버에 얹는다.
# root로 실행한다:
#
#   bash setup.sh
#
# 전제: 마이가디언 setup.sh가 먼저 실행돼 있다 (Node 22+, Caddy, myguardian 계정,
# /var/lib/myguardian/myguardian.db). 이 스크립트는 그 위에 ourbranch만 추가한다.
# 도메인은 따로 잡지 않고 api.insurguard.life/branch 경로로 연다 (DNS 추가 불필요).

set -euo pipefail

APP_DIR=/opt/ourbranch
DATA_DIR=/var/lib/ourbranch
REPO=https://github.com/hemera1984-dot/ourbranch.git
AUTH_DB=/var/lib/myguardian/myguardian.db

if [ ! -f "$AUTH_DB" ]; then
  echo "마이가디언 DB($AUTH_DB)가 없습니다. 마이가디언 서버를 먼저 설치해야 합니다."
  exit 1
fi

echo "== 1/4 앱 내려받기 =="
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone --depth 1 "$REPO" "$APP_DIR"
fi
mkdir -p "$DATA_DIR"
chown -R myguardian:myguardian "$DATA_DIR"

echo "== 2/4 설정 파일 =="
if [ ! -f "$APP_DIR/server/.env" ]; then
  cat > "$APP_DIR/server/.env" <<EOF
PORT=8788
DB_FILE=$DATA_DIR/ourbranch.db
AUTH_DB_FILE=$AUTH_DB
WEB_DIR=$APP_DIR/web
ALLOWED_ORIGINS=https://app.insurguard.life
EOF
  chown myguardian:myguardian "$APP_DIR/server/.env"
  chmod 600 "$APP_DIR/server/.env"
else
  echo "  기존 .env 유지"
fi

echo "== 3/4 서비스 등록 =="
cat > /etc/systemd/system/ourbranch.service <<EOF
[Unit]
Description=하랑지점 팀 관리 서버
After=network.target

[Service]
ExecStart=/usr/bin/node --env-file=$APP_DIR/server/.env $APP_DIR/server/server.js
WorkingDirectory=$APP_DIR/server
Restart=always
RestartSec=3
User=myguardian
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
# 자기 데이터 + 마이가디언 DB(세션 검증, WAL 파일 접근 때문에 쓰기 경로에 포함)
ReadWritePaths=$DATA_DIR /var/lib/myguardian

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now ourbranch
systemctl restart ourbranch
sleep 2
systemctl is-active --quiet ourbranch && echo "  하랑지점 서버 실행 중" || { journalctl -u ourbranch -n 20 --no-pager; exit 1; }

echo "== 4/4 Caddy 경로 추가 =="
if ! grep -q "handle_path /branch/\*" /etc/caddy/Caddyfile; then
  # api.insurguard.life 블록 맨 앞에 /branch 경로를 끼워넣는다 (기존 라우트보다 먼저)
  sed -i 's|^api.insurguard.life {|api.insurguard.life {\n\tredir /branch /branch/\n\thandle_path /branch/* {\n\t\treverse_proxy 127.0.0.1:8788\n\t}|' /etc/caddy/Caddyfile
  caddy fmt --overwrite /etc/caddy/Caddyfile >/dev/null 2>&1 || true
  systemctl reload caddy
  echo "  /branch 경로 추가됨"
else
  echo "  /branch 경로 이미 있음"
fi

echo
echo "설치 완료 — https://api.insurguard.life/branch/ 에서 확인"
echo "  상태: systemctl status ourbranch"
echo "  로그: journalctl -u ourbranch -f"
echo "  확인: curl -i https://api.insurguard.life/branch/health  (200이면 정상)"
