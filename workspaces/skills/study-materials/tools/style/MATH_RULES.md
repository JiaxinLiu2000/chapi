# Formula rewrite rules (CS6140 printed study sheet — Word equations)

The generator turns every `$...$` segment into a real Word equation (LaTeX → MathML via the `latex2mathml` Python package → Office OMML). Your job: make every formula readable by rewriting plain-text math into `$LaTeX$`.

1. Wrap every mathematical expression in `$...$`: equations, inequalities with symbols, formulas, probabilities like P(A|B), variables with subscripts/superscripts (r_ui, x², w₁), Greek-letter expressions (α = ½ln((1−ε)/ε)), fractions, sums/products, norms ‖w‖², gradients ∂L/∂w, vectors, matrix shapes, Big-O. Example: `min Σ_(观测的(u,i)) (r_ui − u_u·v_i)² + λ(‖u‖²+‖v‖²)` → `$\min \sum_{(u,i)\in\Omega} (r_{ui} - \mathbf{u}_u^\top \mathbf{v}_i)^2 + \lambda(\lVert \mathbf{u}\rVert^2 + \lVert \mathbf{v}\rVert^2)$`（Ω = 已观测的评分）— if the original had Chinese inside the formula, move the Chinese outside the `$...$` as a short note.
2. Plain numbers, percentages, page refs and simple prose numbers stay as text ("第 1 轮", "36.8%", "p12", "5 个模型"). A pure arithmetic chain may stay as text (`0.9×5 + 0.6×3 = 6.3`) unless it has fractions, powers, roots or sums — then use `$...$` (e.g. `$\frac{0.0099}{0.0594} = \frac{1}{6}$`).
3. LaTeX that latex2mathml handles well: `\frac{}{}`, `\dfrac` (write as `\frac`), `^{}`, `_{}`, `\sum_{i=1}^{n}`, `\prod`, `\sqrt{}`, `\lVert x \rVert`, `|x|`, `\mid` for the conditional bar, `\hat{}`, `\bar{}`, `\mathbf{}`, `^\top` (transpose), `\ln`, `\log`, `\exp`, `\min`, `\max`, `\mathrm{argmax}`, `\mathrm{softmax}`, `\sigma`, `\alpha`…, `\partial`, `\nabla`, `\approx`, `\le`, `\ge`, `\ne`, `\propto`, `\in`, `\cdot`, `\times`, `\to`, `\leftarrow`, `\infty`, `\left( \right)`, `\text{...}` (ASCII only). Avoid environments (`\begin{...}`), `\dfrac`, `\tfrac`, `\boldsymbol`, `\operatorname`, macros, and Unicode symbols inside math (write `\Sigma` not Σ, `^2` not ²).
4. NO Chinese characters and NO `**` inside `$...$`. Bold markers go outside: `**$\alpha = 0.5$**` is fine.
5. Do not change wording, meaning, numbers, bullet order/count, table shape, or JSON keys. Never touch fields: src, fig, img, w, img_first, extra, f, s, l.
6. Keep it compact: inline formulas only (no `$$`). Long formulas are fine inline.

Validate before finishing (must show errors=0; read every WARN and fix real problems — warnings about digit multiset are expected only where ² became ^2 etc.; "plain-text math left?" warnings must be resolved unless it's a false positive like a URL or "W4_p3"):
```
cd C:\Users\tygac\Downloads\chapi\sessions\cmwal5dvh00z2qlc87cwslmxg\sandbox\cs6140_quiz
uv run --with latex2mathml --with lxml --with python-docx python check_math.py <IN.json> <OUT.json>
```
