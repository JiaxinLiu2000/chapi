# 技能：网页搜索与抓取（脚本驱动 cloakbrowser，over CDP）

## 何时使用
- 需要在 Google / 互联网搜索信息。
- 需要从固定网站提取内容（表格、文章、价格等）。
- 需要登录态才能访问的页面（用持久化登录的受控浏览器）。

## 主要方式：用 `chapi_browser` 助手写脚本驱动 cloakbrowser
平台的浏览器是 **cloakbrowser**（反检测内核 + 持久化登录 profile），始终在后台运行。
**用脚本接管它**，而不是用 Playwright MCP（`mcp__browser__*` 默认关闭，启动慢且易卡）。

会话沙盘里已自动放好 `chapi_browser.py`，直接 import 即可：

```python
from chapi_browser import open_page

# 单页：打开 → 操作 → 提取（退出时只关这个页面，不动共享浏览器）
with open_page("https://www.google.com/search?q=site:example.com+pricing") as page:
    page.wait_for_load_state("networkidle")
    print(page.title())
    # 用标准 Playwright API：page.click / page.fill / page.locator(...).inner_text() / page.content()
    items = page.locator("div.result").all_inner_texts()
    print(items[:5])
```

运行脚本（在沙盘 cwd 用 Bash）：
```
uv run --with playwright python research.py
```
- `connect_over_cdp` 只需 `playwright` 这个 Python 包，**不需要** `playwright install` 下载内核
  （连的是已在跑的 cloakbrowser）。
- 新开的页面会**自动出现在右侧「实时浏览器」**，用户可实时观察。

### 多页 / 交互复杂时
```python
from chapi_browser import connect
with connect() as ctx:            # ctx = 持久化 profile（含登录态）
    page = ctx.new_page(); page.goto("https://example.com/login")
    # ... 多步交互 ...
    page.close()                  # 只关你开的页面；别 ctx.close() / browser.close()
```

### 异步（并行抓多页）
```python
import asyncio
from chapi_browser import open_page_async
async def grab(url):
    async with open_page_async(url) as page:
        return await page.title()
print(asyncio.run(asyncio.gather(*[grab(u) for u in urls])))
```

## 安全约定（避免弄坏共享浏览器）
- **绝不** `browser.close()` / `context.close()`（会断开连接、清空已开页面；助手已封装好，不要绕过）。
- 只 `page.close()` 你自己开的页面。默认上下文是大家共用的持久化 profile。
- 自检连接：`uv run --with playwright python chapi_browser.py https://example.com`。

## 登录
- cloakbrowser 使用**专用持久化 profile**。若目标站点需要登录而当前未登录，调用 `ask_user`
  请用户在受控浏览器窗口完成一次登录（登录态持久保存、后续脚本自动复用）。

## 抓取结果的处理
- 要点必要时用 `wiki_write` 沉淀（带 URL 来源）；临时数据放会话 `memory/web-cache`。

## 失败回退
- 被风控/验证码：不要硬刚；调用 `ask_user` 说明情况、请用户协助或更换策略。
- 连接失败（`chapi_browser` 报 CDP 连不上）：确认设置里已启用浏览器且已就绪（首次需下载内核）；可先跑自检命令。
- Playwright 用法不清/报错：用 `context7` 或 `WebFetch` 查 Playwright 官方文档再重试。
- 批量/重复抓取：见 `batch-scripting` 技能（先跑通→写脚本→小批测试→全量→抽查）。
