# 技能：学习材料（讲解 / cheatsheet / 翻面卡 / 复习讲义 / 练习题）

> 适用：用户在学 ML / AI / 数学 / CS 课程时的**提问讲解**，以及生成 **cheatsheet、复习讲义、翻面卡、练习题、错题整理**。
> 本目录 `tools/` 下是两门课（CS6140 翻面卡+打印讲义、CS5100 197 页讲义）已验证通过的脚本，**直接复用，别从零写**。

## 0. 动手前先问清楚（缺一项就 `ask_user`）
- **考试/用途**：哪门课、什么时候考、题型（判断+理由 / 计算 / 推导 / 简答）、考试语言、是否允许带 cheatsheet（几张、A4/Letter、单双面）。
- **资料来源**：课件、笔记、作业、往年题在哪（`原始资料/` 或用户给的路径）。**以课程资料为准**：用老师的记号和例题数字；资料外补充的内容标 **（课外补充）**；资料含糊就直说，不编造课程事实。
- **交付形态**：聊天里讲 / 交互翻面卡（HTML）/ 打印 cheatsheet（docx+PDF）/ 长讲义（Google Doc）。

## 1. 聊天里讲解一个概念或公式（网页 KaTeX 渲染）
- 公式写 LaTeX：行内 `$...$`，独立公式 `$$...$$` 单独成段，推导用 `\begin{aligned}` + `&=` 对齐。**不要**放进代码块，**不要**用 x²、θᵢ 这类 Unicode 凑。
- 讲解顺序：**一句话直觉** → **公式** → **逐个符号**（含维度/形状，如 $X\in\mathbb{R}^{n\times d}$）→ **小数值例子**（真算一遍，复杂算术用 Python 验证）→ **为什么这样设计 / 换个条件会怎样** → **常见误区**。
- 推导题不跳步；每步写依据（链式法则、矩阵求导恒等式、独立性假设……）。
- 术语按用户偏好写 `English（中文）`（首次出现），之后只写英文。

## 2. 选格式 → 用对应工具
| 交付 | 做法 | 工具 |
|---|---|---|
| 交互翻面卡（手机/电脑复习） | 单个离线 HTML，内嵌 KaTeX 字体和图片 | `tools/flashcards/`：`template.html` + `build.py`（拼卡片 JS、内嵌 KaTeX 0.16.11 woff2 与图片）+ `test_math.py`（无头浏览器检查公式渲染错误=0） |
| 打印 cheatsheet / 复习讲义（docx+PDF） | 两栏、约 8pt、**黑白**；公式是**真 Word 公式**（OMML） | `tools/word-math/`：`omml.py`（`$LaTeX$`→MathML→OMML，勿嵌套 oMathPara）、`sheet.py`（两栏版式构建器）、`tbl_width.py`（表格显式列宽，否则 Google Docs 溢出）、`check_math.py`（改写后校验） |
| 长讲义放 Google Docs | Markdown → pandoc → docx → 上传 | `tools/gdocs-math/`：`build.py` + `render.js`（MathJax 把矩阵/cases/aligned/长公式转 PNG——**Google Docs 会把它们压成一行**）、`lint_docx.py`、`check_pdf.py` |
| 写作规范模板 | 给子代理的统一规则 | `tools/style/`：`STYLE.md`（零基础讲义章节结构）、`MATH_RULES.md`（Word 公式可用的 LaTeX 子集）、`TERM_RULES.md`（English（中文）术语改写规则） |

脚本复制到会话沙盘再改（路径/文件名按本次课程调整），运行用 `uv run --with ... python -I 脚本.py`。
翻面卡 `build.py` 需要旁边有 `katex_dl/package/dist`：在沙盘里 `npm pack katex@0.16.11` 后解压到 `katex_dl/`。`gdocs-math/render.js` 先在其目录 `npm install`（依赖见 `package.json`）。

## 3. 内容质量（好材料 ≠ 摘要）
- **主动回忆优先**：翻面卡/复习题是"问→答"，不是把课件抄一遍。一张卡只考一个点。
- 默认包含四块（翻面卡尤其如此）：**概念卡**（仿老师出题风格）、**计算题**（手算可解、Python 验证答案）、**课件图**（图 → 要看懂什么）、**深度理解**（why / what-if / 诊断 / 跨章节对比）。
- **易错点 + 常见考法**：每个主题列出典型陷阱；考英文时附 **英文答题模板**（2–5 句可直接写在卷子上的话）。
- **跨章综合**：对比表（如 L1 vs L2、Bagging vs Boosting、生成式 vs 判别式），写清适用条件和失效条件。
- **配图**：能画就画（matplotlib/networkx）：决策边界、损失曲面、梯度下降步、网络结构、搜索树等；打印版字体缩放后 ≥ 9pt，黑白用线型/标记区分。

## 4. cheatsheet 专项
- 先确认纸张和面数，按**考点权重**分配版面；只放公式 + 适用条件 + 一行提示，**不放推导**。
- 每个公式标出变量含义和前提（如"仅当特征独立"、"$\lambda>0$"）。易混公式并排放。
- 生成后导出 PDF **数页数**，超出就压缩（合并表格、缩小图）而不是删考点；渲染每页 PNG 肉眼看一遍可读性。

## 5. 交付前验收（缺一不可）
1. 公式渲染错误 = 0（HTML 用 `test_math.py`；docx 用 `check_math.py`；PDF 抽页渲染看）。
2. 所有计算题答案 Python 复算一致。
3. 覆盖率：按课件逐页/逐讲核对，没漏考点（用户笔记里已有的、用户只要"笔记外"内容时要剔除）。
4. 术语格式、黑白、页数/文件大小（Drive 导出 PDF 上限约 10MB：图 ≤950px、32 色）。
5. 上传 Drive（更新时**沿用同一个文件 ID**），`save_artifact` + `request_approval`。

## 失败回退
- Google Docs 公式变形/压成一行 → 走 `gdocs-math` 的 MathJax 转图。
- Word 打开报错 → 多半是嵌套了 oMathPara 或公式里有中文/`**`，用 `check_math.py` 定位。
- 题目要求不明确 → 先要题目原文，不擅自加题目没要求的内容。
