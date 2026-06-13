# 技能：网页搜索与抓取（cloakbrowser，**像真人一样**操作）

## 何时使用
- 需要在 Google / 互联网搜索信息。
- 需要从固定网站提取内容（表格、文章、价格等）。
- 需要登录态才能访问的页面（用持久化登录的受控浏览器）。

## 铁律：始终经 cloakbrowser + 模拟真人
反爬（Akamai、PerimeterX 等）**主要靠行为识别机器人**，不是只看指纹。脚本跑太快、冷链接直达详情页、
循环猛刷，都会被封——而且其挑战脚本会把浏览器 CPU 拖满，导致**整个 cloakbrowser 卡死/打不开页面**。
所以无论**探索**还是**写脚本**，都必须：
1. **始终经 cloakbrowser**：用沙盘里的 `chapi_browser` 接管正在运行的浏览器；**不要另起浏览器、不要裸 requests/httpx**。
2. **单驱动**：同一时刻只允许一个脚本驱动浏览器（已加跨进程 CDP 锁，多个会自动排队）。单页复用 `ctx.pages[0]`；要同时看两页就在**一个连接**里 `new_tab`（最多 2）。别用两个独立脚本/子代理同时连。
3. **动作间随机停顿** + 滚动 + 移动鼠标：用 `human_goto / human_click / human_scroll / human_pause / human_type`，别瞬间连点。
4. **顺网站路径走**：先 `warmup`/打开首页或列表/搜索页，再 **点进** 详情页；**绝不直接 goto 深层详情 URL**。
5. **翻页点"下一页"按钮**：用 `click_next(page)`，**别拼 `?page=2` 冷跳**。
6. **节流 + 低并发**：同一站点**一个页面顺序慢走**，循环里必有随机停顿；不要并发猛刷同域名。
7. **被封/验证码 → 停手**：降低频率、换思路或 `ask_user`，不要硬刚（硬刚只会把 IP/账号烧掉）。

`chapi_browser.py` 已自动放进会话沙盘，直接 import。搜索框常是延迟/封装加载（`inputs: 0`）——
用 `wait_for_any(page, [...selectors])` 或 `page.get_by_role("searchbox")` 等它出现再操作。

## 拟人浏览示例（同步）
```python
from chapi_browser import open_page, warmup, human_click, human_scroll, human_pause

with open_page() as page:                      # 新开一个页面（会显示在实时浏览器）
    warmup(page, "https://site.com/")           # 先暖身：首页 + 随机停顿 + 滚动
    human_click(page, "text=Search")            # 顺着导航走
    human_scroll(page)                          # 像真人一样浏览列表
    # 点进详情，而不是冷 goto 详情 URL：
    for card in page.locator("div.result").all():
        link = card.locator("a")
        human_click(page, link)                 # 滚动到可见→悬停→点击→随机停顿
        title = page.locator("h1").inner_text()
        print(title)
        page.go_back()                          # 回列表
        human_pause()                           # 再随机停顿
```

运行：`uv run --with playwright python research.py`
（connect_over_cdp 只需 `playwright` 包，**不需要** `playwright install`。）

## 单驱动模型（重要）
**同一时刻只能有一个脚本驱动 cloakbrowser。** `connect()`/`open_page()` 已加**跨进程 CDP 锁**：
两个子代理同时连会自动**排队串行**，不再握手踩踏卡死。所以：
- 单页任务：`open_page()` 或 `connect()` + `active_page(ctx)`（复用 `ctx.pages[0]`）。
- **不要**为了"并行抓"派两个子代理各自连浏览器——它们会排队，反而更慢。真要并行只用于**不同任务**，且其中最多一个用浏览器。

## 用 connect（复用默认页 + 可多开标签）
```python
from chapi_browser import connect, active_page, new_tab, human_pause
with connect() as ctx:            # 持久化 profile（含登录态），全程持有 CDP 锁
    page = active_page(ctx)       # = ctx.pages[0]，复用默认页
    # ...拟人交互，循环里 human_pause()...
    # 不要 ctx.close()/browser.close()
```

## 同时浏览两个页面（在同一连接里开第二个标签）
```python
from chapi_browser import connect, active_page, new_tab, human_goto, human_pause
with connect() as ctx:
    a = active_page(ctx); human_goto(a, "https://site-a.com/")
    b = new_tab(ctx, "https://site-b.com/")   # 第二个标签页（实时浏览器上下分屏，最多 2）
    # 交替/并发操作 a、b 两页 ...
    b.close()                      # 用完关掉额外标签；a 可 goto("about:blank")
```
（这是"同时看两个网页"的正确做法——一个脚本、一把锁、两个标签；不要两个脚本/子代理同时连。）

## 安全约定（别弄坏共享浏览器）
- **绝不** `browser.close()` / `context.close()`（会断连、清空已开页面、拖垮实时浏览器）。
- 只 `page.close()` 你自己开的页面。
- 自检连接：`uv run --with playwright python chapi_browser.py https://example.com`。

## 登录
- cloakbrowser 用**专用持久化 profile**。目标站点需登录而未登录时，调用 `ask_user` 请用户在浏览器窗口
  完成一次登录（登录态持久保存、后续脚本自动复用）。

## 失败回退
- 被风控/验证码：见铁律第 5 条，**停手**别硬刚。
- 连接失败（CDP 连不上）：确认设置已启用浏览器且就绪（首次需下载内核）；先跑自检命令。
- Playwright 用法不清/报错：用 `context7` 或 `WebFetch` 查官方文档再重试。
- 批量/重复抓取：见 `batch-scripting`（先跑通→写脚本→小批测试→全量→抽查，全程拟人）。
