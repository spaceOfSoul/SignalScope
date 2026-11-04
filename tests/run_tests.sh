#!/bin/sh
# 헤드리스 Chrome 으로 코어 테스트 실행:  sh tests/run_tests.sh [섹션번호,...]
DIR="$(cd "$(dirname "$0")" && (pwd -W 2>/dev/null || pwd))"
CHROME="${CHROME:-/c/Program Files/Google/Chrome/Application/chrome.exe}"
HASH=""; [ -n "$1" ] && HASH="#$1"
timeout "${TEST_TIMEOUT:-90}" "$CHROME" --headless=new --disable-gpu --no-sandbox --allow-file-access-from-files \
  --virtual-time-budget=30000 --dump-dom "file:///$DIR/test.html$HASH" 2>/dev/null \
  | python -c "import sys,re,html; d=sys.stdin.read(); m=re.search(r'<pre id=\"out\">(.*?)</pre>', d, re.S); print(html.unescape(m.group(1)) if m else 'NO OUTPUT')"
