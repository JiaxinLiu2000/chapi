# 技能：联网搜索、抓取与置信度

## 何时使用
- 需要在互联网上搜索信息（**一律用 cloakbrowser 里的 Google 拟人搜索，至少看 2 页**）。
- 需要从固定网站提取内容（表格、文章、价格等）——**先 `site_recon` 侦察反爬等级再选方法**。
- 需要登录态才能访问的页面（用持久化登录的受控浏览器）。

## 一、搜索：Google 拟人搜索（每个关键词 ≥ 2 页）
内置 `WebSearch` 结果少、部分网站拒绝它访问，只能当补充。标准做法：
```python
from chapi_browser import open_page, google_search, human_pause
with open_page() as page:
    serp = google_search(page, "Brodsky Organization number of apartments", pages=2)
    human_pause(3, 7)
    serp += google_search(page, "Brodsky Organization portfolio units site:brodsky.com", pages=2)
for r in serp:
    print(r["page"], r["title"], r["url"], r["date"], r["snippet"][:120])
```
命令行：`uv run --with playwright python chapi_browser.py google "q1" "q2" --pages 2 --json serp.json`
- 换 2–4 种关键词/英文表述（含 `site:` 官方域名、年份、"official"、"press release" 等）。
- 打开最相关的结果读**原文**再下结论；摘要里的 `date` 只是线索，以原文日期为准。
- 出现 `GoogleCaptcha`：`ask_user` 请用户在实时浏览器里完成人机验证，再重试；别连续硬刷。

## 二、多来源 + 置信度（`rate_sources`）
- 每个关键事实/数据**至少 3 个独立来源**（条件允许时）。同一网站的多个页面只算 1 个；多家媒体转载同一新闻稿时尽量追到原始出处。
- 记录每个来源：URL、发布/更新日期、类型（tier）。**公司/机构自己的官网、政府/监管文件、官方 API = `official`**（工具按域名推断不出来，必须显式填）。
- 调 `rate_sources` 计算：
  - 单来源 `c = R × (0.5 + 0.5 × F)`；R：official 0.95 · reputable 0.80（权威媒体/学术/行业数据库）· aggregator 0.65（Zillow、apartments.com、LinkedIn、Wikipedia 等平台）· community 0.40（论坛/博客/社交）· unknown 0.30。
  - 新鲜度 `F = 0.5^(天数/半衰期)`：`fast`=90 天（价格/租金/房源/新闻/任职）· `medium`=365 天（公司信息、年度统计）· `slow`=1825 天（历史、现行法规、定义）；无日期 F=0.5。
  - 多个独立来源**指向同一数值 → 叠加**：`C = 1 − (1 − c₁) × Π(1 − 0.8·cᵢ)`（最强来源全额计入，其余打 0.8 折防"互相抄"）；有矛盾来源 `C × (1 − 0.5·C矛盾)`。
  - ≥85% 高 · ≥60% 中 · 否则低。
- 交付时标注：表格加「置信度」「来源」列；正文写 `（置信度 87%·高，3 个来源）`；<60% 标「待核实」；来源冲突要写明采用哪个、为什么。

## 三、抓取：先 `site_recon`，按等级选策略（别一律最保守）
| 等级 | 典型信号 | 方法 | 并发 / 延时 |
|---|---|---|---|
| **L0 无防护** | 纯 HTTP 200 拿到完整内容、无反爬厂商 | **直接调 API / 纯 HTTP**，跳过网页 | 同域 4–8 并发，不加延时 |
| **L1 轻度** | CDN（Cloudflare 无挑战）、限流头、Crawl-delay | 纯 HTTP + 浏览器请求头，可直接请求深层 URL | 2–3 并发，0.5–1.5s 随机，429 退避 |
| **L2 中度** | 反爬厂商在但未挑战（`__cf_bm`、`_abck`、Imperva cookie）、纯前端渲染 | cloakbrowser 渲染，可直接 goto 深层 URL / 拼分页 | 单页面顺序，每页 1–3s |
| **L3 强** | 挑战页/403（Akamai、DataDome、PerimeterX、Kasada）、已知强站点 | cloakbrowser + **完整拟人协议**（下面"铁律"） | 单页面顺序，动作间 human_pause |

- `site_recon` 还会给出**数据入口线索**：`__NEXT_DATA__`、JSON-LD、`/wp-json/`、Shopify `/products.json`、页面引用的 `/api/…`、URL 本身就是 JSON 等——等级 ≤ L1 时优先直接调这些接口。
- 也可以在浏览器里打开一次页面、用 `page.on("response", …)` 看 XHR 返回的 JSON，找到接口后（L0/L1）直接用 HTTP 调。
- 结果按域名缓存 7 天（`data/site-profiles.json`）。**被拦截/出验证码 → 立即停手**，`site_recon(url, report="blocked")` 升一级换更保守的方式；某等级跑通了 `report="ok"`。

## 四、L3 铁律（以及所有用浏览器时的通用规则）
强反爬（Akamai、PerimeterX 等）**主要靠行为识别机器人**。脚本跑太快、冷链接直达详情页、循环猛刷都会被封——
其挑战脚本还会把浏览器 CPU 拖满，导致**整个 cloakbrowser 卡死**。L3 站点无论探索还是写脚本都必须：
1. **始终经 cloakbrowser**：用沙盘里的 `chapi_browser` 接管正在运行的浏览器；**不要另起浏览器**。
2. **单驱动**：同一时刻只允许一个脚本驱动浏览器（已加跨进程 CDP 锁，多个会自动排队）。单页复用 `ctx.pages[0]`；要同时看两页就在**一个连接**里 `new_tab`（最多 2）。（L0–L3 通用）
3. **动作间随机停顿** + 滚动 + 移动鼠标：用 `human_goto / human_click / human_scroll / human_pause / human_type`。
4. **顺网站路径走**：先 `warmup`/打开首页或列表/搜索页，再 **点进** 详情页；**绝不直接 goto 深层详情 URL**。
5. **翻页点"下一页"按钮**：用 `click_next(page)`，**别拼 `?page=2` 冷跳**。
6. **节流 + 低并发**：同一站点**一个页面顺序慢走**，循环里必有随机停顿。
7. **被封/验证码 → 停手**：降低频率、换思路或 `ask_user`，不要硬刚。（L0–L3 通用）

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

## 登录（需要用户手动登录时——务必按此，否则用户浏览器会卡死）
cloakbrowser 用**专用持久化 profile**，登录态持久保存、后续脚本自动复用。需要用户登录时：

1. **`open_login("https://…登录页")`**：打开登录页后**立即断开自动化**（清掉 Playwright 的 auto-attach）。
2. **`ask_user("请在浏览器里登录，完成后回复我")`**：期间浏览器**完全交给用户**，可自由操作/开新标签。
3. 用户回复后，再 `open_page`/`connect` 继续（此时已登录）。

```python
from chapi_browser import open_login
open_login("https://accounts.google.com/")   # 打开并放手；随后调用 ask_user 等用户完成
```

⚠️ **绝不要**用 `open_page`/`connect` 打开登录页后**一直占着**浏览器等用户登录——那样浏览器处于自动化
（auto-attach）控制下，用户开任何新标签都会**一直"加载中"卡死**。必须先 `open_login` 放手。

## 失败回退
- 被风控/验证码：见铁律第 5 条，**停手**别硬刚。
- 连接失败（CDP 连不上）：确认设置已启用浏览器且就绪（首次需下载内核）；先跑自检命令。
- Playwright 用法不清/报错：用 `context7` 或 `WebFetch` 查官方文档再重试。
- 批量/重复抓取：见 `batch-scripting`（先跑通→写脚本→小批测试→全量→抽查，全程拟人）。
