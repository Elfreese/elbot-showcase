#!/bin/bash
# calls-demo: 通过 Elvena v3 调用平台原生 API；先将 params 中的示例 ID 改成实际值。
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
    "elwisp": {"name": "calls-demo-example", "tags": ["example", "calls"]},
    "source": "calls-demo-example",
    "id": sys.argv[1],
    "mode": "direct",
    "title": "calls 动作调用演示",
    "content": "已执行以下平台动作：撤回消息、禁言成员、退出群聊。",
    "calls": [
        {"platform": "telegram", "api": "deleteMessage", "params": {"chat_id": 123456, "message_id": 42}},
        {"platform": "qqonebot", "api": "set_group_ban", "params": {"group_id": 987654321, "user_id": 11111, "duration": 60}},
        {"platform": "qqonebot", "api": "set_group_leave", "params": {"group_id": 987654321}},
    ],
    "targets": [{"platform": "cli"}],
}, ensure_ascii=False))
PY
)

curl --fail-with-body --silent --show-error -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "$PAYLOAD" | python3 -m json.tool
