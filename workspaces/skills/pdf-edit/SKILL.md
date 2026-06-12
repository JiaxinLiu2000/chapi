# 技能：PDF 编辑（现有模板文字替换为主）

> 云端优先：**从头要做精美/设计型 PDF → 优先用 Canva**（产物在云端）。
> 本技能用于**替换现有 PDF 模板里的文字**（必须本地完成），沙盘仅作临时工作区，
> 改好后**上传 Google Drive** 再交付。

## 如何使用（本地、离线、免费）
工具：`mcp__chapi__pdf_edit`，路径相对会话沙盘。
- 先查结构：`{ op: "info", input: "template.pdf" }` → 返回页数、表单字段、文本预览。
- **表单字段模板（AcroForm，最稳）**：`{ op: "fill-form", input, output, data: { 字段名: 值 } }`。
- **自由文本占位符**（如 `{{name}}`）：`{ op: "replace-text", input, output, data: { "{{name}}": "张三", "{{amount}}": "¥12,500" } }`
  （用 PyMuPDF redaction 覆盖原文并重写；注意字体/版式可能轻微变化）。

## 流程建议
1. 把模板放入沙盘（或从原始资料复制）。
2. `info` 确认是表单字段还是占位符文本，选择对应 op。
3. 生成新 PDF 到沙盘，**上传到 Google Drive** 并用 `save_artifact`(kind=drive) 返回分享链接
   （Drive 不可用时才用 kind=pdf 给沙盘路径，并提示开启 Google 接入）。
4. 用 `request_approval` 提交给用户审批。

## 何时用 Canva（次要）
仅当需要**从头设计/排版**好看的稿件时，用 Canva MCP；它不擅长在既有 PDF 上精确改字。

## 失败回退
- 占位符没替换成功：用 `info` 核对原文是否完全匹配（含空格/换行），调整映射。
- 报错：阅读 PyMuPDF/pypdf 文档（context7/WebFetch）后重试。
