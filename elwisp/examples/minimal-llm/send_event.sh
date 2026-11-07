#!/bin/bash
# minimal-llm: 发送一条 Elvena v3 llm 事件，启动后台分析
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

content = """#task review_event - 判断事件是否需要通知
<- $event:object!
-> $report:str
** 基于事件内容、meta 和工具结果判断
~ 编造日志、指标或结论
> 如果需要通知，给出原因和建议；否则说明无需打扰。"""

print(json.dumps({
    "version": "elvena.v3",
    "elwisp": {"name": "minimal-llm-example", "tags": ["example", "minimal"]},
    "source": "minimal-llm-example",
    "id": sys.argv[1],
    "mode": "llm",
    "title": "测试 LLM 事件",
    "format": "elyph",
    "content": content,
    "tool_list_names": [],
    "targets": [{"platform": "cli"}],
    "meta": {},
}, ensure_ascii=False))
PY
)

curl --fail-with-body --silent --show-error -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "$PAYLOAD" | python3 -m json.tool
