#!/usr/bin/env bash
# Cloudflare 무료 터널(https://xxxx.trycloudflare.com)로 서버를 인터넷에 공개.
# 학교/회사 방화벽이 외부 접속을 막아도 동작 (이 PC가 바깥으로 연결을 여는 방식).
# 주의: 실행할 때마다 주소가 바뀌므로, 재시작하면 공유 링크를 다시 보내야 함.
#
#   ./start-public.sh [추가 server.py 옵션...]     예: ./start-public.sh --port 9000
set -euo pipefail
cd "$(dirname "$0")"

PORT=8000
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  [[ ${args[i]} == --port ]] && PORT=${args[i + 1]}
  [[ ${args[i]} == --port=* ]] && PORT=${args[i]#--port=}
done

CF=$(command -v cloudflared || echo "$HOME/.local/bin/cloudflared")
[[ -x $CF ]] || { echo "cloudflared 가 없습니다. README.txt 의 설치 방법을 참고하세요." >&2; exit 1; }

LOG=$(mktemp)
# --protocol http2: 학교망은 QUIC(UDP 7844)을 막으므로 TCP 로 연결
"$CF" tunnel --no-autoupdate --protocol http2 --url "http://localhost:$PORT" >"$LOG" 2>&1 &
CF_PID=$!
trap 'kill $CF_PID 2>/dev/null; rm -f "$LOG"' EXIT

echo "터널 여는 중…"
URL=""
for _ in $(seq 60); do
  URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG" | head -n1 || true)
  [[ -n $URL ]] && break
  kill -0 $CF_PID 2>/dev/null || { cat "$LOG" >&2; exit 1; }
  sleep 1
done
[[ -n $URL ]] || { echo "터널 주소를 받지 못했습니다:" >&2; cat "$LOG" >&2; exit 1; }

echo "공개 주소: $URL"
python3 server.py --public-url "$URL" "$@"
