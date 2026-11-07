#!/bin/bash
# minimal-direct: 发送一条 Elvena v3 direct 事件到 Elnis
set -eo pipefail

ENDPOINT="${ELNIS_ENDPOINT:-http://127.0.0.1:32170/elvena/v3/events}"
TOKEN="${ELNIS_TOKEN:-}"

if [ -z "$TOKEN" ]; then
    echo "错误: 请设置 ELNIS_TOKEN 环境变量" >&2
    exit 1
fi

PAYLOAD=$(python3 - "test-$(date +%s%N)" <<'PY'
import json
import sys

print(json.dumps({
    "version": "elvena.v3",
    "elwisp": {"name": "minimal-direct-example", "tags": ["example", "minimal"]},
    "source": "minimal-direct-example",
    "id": sys.argv[1],
    "mode": "direct",
    "title": "测试事件",
    "content": "Elwisp Showcase minimal-direct 示例发送成功。",
    "targets": [{"platform": "cli"}],
}, ensure_ascii=False))
PY
)

curl --fail-with-body --silent --show-error -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "$PAYLOAD" | python3 -m json.tool
