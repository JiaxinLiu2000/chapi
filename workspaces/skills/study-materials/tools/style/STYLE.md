# CS 5100 Midterm (Quiz) Study Guide — writing rules (all writers must follow)

Reader: a student with ZERO background in AI, calculus, linear algebra and probability. Quiz is Monday 11/16/2026, in English, open one A4 cheat sheet (both sides). Questions are True/False-with-justification, MDP calculations, search formulations, derivations (gradients, likelihood), and short explanations. Students must "show steps"; they may cite results proven in HWs.

## Language
- Body text in **Simplified Chinese**. Every technical term written as **English（中文）** at its first occurrence in each section (e.g. "Breadth-First Search（广度优先搜索，BFS）", "heuristic（启发函数）"), English only afterwards. Keep variable names / notation in English.
- At the end of each major topic add a short box "**英文答题模板**" with 2–5 ready-to-use English sentences the student can write on the exam (e.g. "False. BFS returns the path with the fewest edges, not the lowest cost, because ...").

## Source fidelity
- Main source = the instructor's lecture transcriptions in `cs5100/notes/Lxx.md` (handwritten notes, faithfully transcribed), the homework texts `cs5100/text/HW*.txt`, past quizzes `cs5100/text/Quiz_*.txt`, `cs5100/text/MDP_practice.txt`. Use the instructor's notation and examples (same numbers). Cite the source in parentheses like （L7）,（HW3 第 2 题）,（2025 秋季小测 第 3 题）.
- Anything you add that is NOT in the course materials (e.g. a general definition from textbooks to help understanding) must be tagged **（课外补充）**. Never invent course facts. If the notes are ambiguous, say so.
- Verify every numeric calculation (run a quick Python check with `python -I -c ...` when there is any arithmetic beyond trivial).

## Structure for each topic (use what fits)
1. **一句话直觉**: what problem it solves, in plain words, with an everyday analogy.
2. **定义 / 关键概念**: precise definitions.
3. **公式**: displayed, with every symbol explained right below ("其中 …").
4. **课堂例题（逐步）**: the instructor's worked example step by step, no skipped steps.
5. **常见考法与易错点**: bullet list (how it appears on quizzes; typical traps).
6. **英文答题模板**.
Use plenty of small headings; short paragraphs; tables for comparisons.

## Markdown / math format (it is converted by pandoc into a Word doc with native equations, then to Google Docs)
- Headings: `#` = chapter ("# 第3章 Markov Decision Processes（马尔可夫决策过程）"), `##` = section ("## 3.2 …"), `###` = subsection. Do not number deeper than ###.
- Math: inline `$...$`, display `$$...$$` on its own lines (blank line before and after). Use standard LaTeX: \frac, \dfrac, \sum_{i=1}^{n}, \prod, \vec{\beta}, \nabla_{\vec\beta}, \begin{pmatrix}..\end{pmatrix}, \begin{cases}..\end{cases}, \max_a, \log, \ln, \le, \ge, \neq, \infty, \text{...}, \underbrace{..}_{..}, \quad, \cdot, \times, \left( \right).
- DO NOT use: \boxed, \cancel, \color, \require, \tag, \label, \eqref, \begin{align} (use separate $$ lines or \begin{aligned} inside $$), \bm, \mathbbm, macros you define yourself, `\\` line breaks outside environments.
- Never put a `$` dollar sign for money; write "USD 10" or "10 美元".
- Tables: pipe tables (`| a | b |` with header separator). Keep ≤ 5 columns. Math inside cells is OK.
- Bold with `**…**`. Bullets with `- `. Numbered steps with `1. `.
- Callout boxes: write as a blockquote starting with a bold label, e.g. `> **易错点**：…` or `> **英文答题模板**：` followed by `> - "..."` lines.
- Code: fenced ```python blocks (short).
- Figures: `![图 3-1 价值迭代示意](figs/ch3_value_iteration.png)` on its own paragraph. Make figures with matplotlib (and networkx if useful) via `uv run --with matplotlib --with networkx --with numpy python -I script.py`; save scripts in `cs5100/figs/src/` and PNGs (dpi 200, white background, clear labels, font size ≥ 11, width ~7 in) in `cs5100/figs/`. Prefix file names with your chapter id (ch1_, ch2_, …) to avoid collisions. Make figures for anything visual: search trees and graphs with weights, frontier tables, Bayes-net diagrams, MDP state diagrams, grid worlds, value-iteration tables, norm unit balls / outlier effect, tangent/derivative, gradient descent steps, under/overfitting, sigmoid, decision boundary, Newton tangent steps, neural-network layer diagram, backprop chain.

## Length
Be thorough and detailed (this is the student's only study source), but not padded. Each chapter typically 3,000–8,000 Chinese characters plus formulas, examples and figures.

## Output
Write each chapter to `cs5100/draft/chN.md` (UTF-8). Write the file with the Write tool (not bash heredoc). Then reply with a short summary: sections, figures created, anything uncertain.
