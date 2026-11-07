# 安全注意事项

## Token 管理

- [x] Token 只通过环境变量传入
- [x] 不在代码中硬编码 token
- [x] 不打印、不记录 token
- [x] 不读取配置目录中的 `.env` 文件并泄露
- [x] `.env` 加入 `.gitignore`

## Elwisp 代码规范

```python
# 正确: 从环境变量读取
import os
token = os.environ.get("ELNIS_TOKEN")

# 错误: 硬编码
token = "my-secret-token"  # 永远不要这样做
```

## 网络绑定

- 外部工具 endpoint 默认绑定 `127.0.0.1`
- 只在用户明确要求时监听非 loopback 地址
- 对外暴露时建议配合反向代理和限流

## 事件内容

- 不编造 endpoint 或 token
- 不发送系统敏感信息
- content 中避免包含明文凭证
- meta 字段不放入未脱敏的日志

## targets

- targets 必须由事件明确声明
- 不要盲目推送到 `{"platform": "all"}`，除非确实需要
- 用户目标不明确时，先询问要推送到哪些平台或会话

## id 稳定性

- event id 在同一 source 内必须稳定且唯一
- Elnis 用 `elwisp.name + source + id` 去重
- 建议用事件的自然键做 id，如文件路径、commit SHA、文章 GUID

## 工具声明

- `tool_list_names` 请求的工具最终由 Elnis `allowed_tools` 和 Security Policy 裁决
- 不要声明超出 Elwisp 职责范围的工具
- `tools` 声明 Elwisp 提供的外部工具，默认允许，单 Elwisp 的 `disabled_external_tools` 可禁用指定工具
- 宿主按 low 风险接入外部工具，工具服务负责实际风险边界；事件不能指定风险等级或获取宿主媒体管理权限
