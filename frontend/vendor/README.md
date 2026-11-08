# 本地浏览器依赖

- Marked 18.1.3：[上游版本](https://github.com/markedjs/marked/releases/tag/v18.1.3)，`marked.umd.js`，MIT 许可见 `marked-LICENSE`。
- DOMPurify 3.4.17：[上游版本](https://github.com/cure53/DOMPurify/releases/tag/3.4.17)，`purify.min.js`，许可见 `DOMPurify-LICENSE`。
- @decimalturn/toml-patch 3.3.2：[上游版本](https://github.com/DecimalTurn/toml-patch/tree/v3.3.2)，`toml-patch.js`，MIT 许可见 `toml-patch-LICENSE`；用于保留注释与格式的配置编辑。

运行时全部从本地加载。Markdown 经 Marked 解析后交给 DOMPurify 清理，不直接插入未经清理的模型 HTML。
