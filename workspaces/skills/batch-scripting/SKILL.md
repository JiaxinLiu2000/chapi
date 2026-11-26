# 技能：批量任务优先写脚本（高效处理）

## 何时使用
- 多页抓取、逐条进详情页、对大量条目做同样处理等**重复性/批量**工作。
- 一个个手动点击/翻页太慢且易错——**优先写脚本自动化**。

## 流程
0. **先 `site_recon(url)` 定等级**：决定用 API/纯 HTTP 还是浏览器、并发多少、延时多长（见 `web-research` 第三节）。**没有反爬的站点别用最保守的拟人慢速**——太慢。
1. **先跑通一次**：L0/L1 先找 JSON 接口/内嵌数据（`__NEXT_DATA__`、`/api/…`），用 HTTP 拿一页看结构；L2/L3 用 `chapi_browser` 走一遍（L3 要拟人：暖身首页 → 点进列表 → 点进详情）。
2. **写脚本**：在沙盘写 Python。L0：`httpx`/`requests` + 线程池并发；L1：同上但 2–3 并发 + 0.5–1.5s 随机延时 + 429 退避；L2：浏览器单页顺序、可直接 goto 深层 URL；L3：`human_*` 拟人、顺路径点进、`click_next` 翻页。
3. **小批测试**：先跑一小批（L3 约 3 页），**随机抽 ~5 条**核对结果。
4. **全量运行**：没问题再全量。中途被拦截 → 停手，`site_recon(url, report="blocked")` 升级等级后换策略。
5. **抽查验收**：用**抽样核对 / 核对数量 / 筛查异常值**验收，**不要逐条肉眼看**。
6. **交付**：优先 Google Sheet/Drive，`save_artifact`；联网得来的关键数据带「置信度」「来源」列（`rate_sources`）。

L0/L1 示例（纯 HTTP 直接调接口，并发、无需浏览器）：
```python
import httpx, random, time
from concurrent.futures import ThreadPoolExecutor
H = {"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
     "accept-language": "en-US,en;q=0.9"}
def get(url, jitter=(0, 0)):           # L1: jitter=(0.5, 1.5)
    time.sleep(random.uniform(*jitter))
    for attempt in range(4):
        r = httpx.get(url, headers=H, timeout=30, follow_redirects=True)
        if r.status_code in (429, 503):
            time.sleep(float(r.headers.get("retry-after", 2 ** attempt * 5))); continue
        r.raise_for_status(); return r.json()
    raise RuntimeError(f"rate limited: {url}")
with ThreadPoolExecutor(6) as ex:      # L0: 4–8；L1: 2–3
    pages = list(ex.map(get, [f"https://example.com/api/items?page={i}" for i in range(1, 21)]))
```

## L2/L3：经 cloakbrowser（L3 还必须模拟真人）
强反爬站点用裸 `requests`/`httpx`/独立 playwright，或脚本跑太快/冷链接直达详情/循环猛刷，**都会被封**，
而且 Akamai 挑战脚本会把 cloakbrowser CPU 拖满导致**卡死/打不开页面**。所以这类站点一律用沙盘里的
**`chapi_browser`** 接管运行中的 cloakbrowser（L3 再加 `human_*` 拟人操作）；它已封装好正确连接、复用反检测内核 +
持久化登录态，**只关你开的页面、绝不关闭共享浏览器**。新开页面会自动出现在「实时浏览器」。

运行：`uv run --with playwright python 脚本.py`（connect_over_cdp 不需要 `playwright install`）。

L3 示例（**顺路径点进**详情、随机停顿、顺序低速，落 CSV）：
```python
import csv
from chapi_browser import open_page, warmup, human_click, human_scroll, human_pause, click_next

rows = []
with open_page() as page:                           # 复用默认页（别 new_page），退出回空白
    warmup(page, "https://example.com/")            # 先暖身首页（建立正常访问轨迹）
    human_click(page, "text=Listings")              # 点进列表，而不是冷 goto
    for _ in range(3):                              # 先跑 ~3 页做测试
        human_scroll(page)
        for link in page.locator("div.item a.detail").all():
            human_click(page, link)                 # 点进详情页（带停顿）
            rows.append({
                "title": page.locator("h1").inner_text(),
                "price": page.locator(".price").inner_text(),
            })
            page.go_back(); human_pause()           # 回列表 + 随机停顿
        if not click_next(page):                    # 点“下一页”按钮；没有就结束（别拼 ?page=N）
            break

with open("out.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=["title", "price"]); w.writeheader(); w.writerows(rows)
print(f"抓到 {len(rows)} 条")
```
（前提：设置里已启用 cloakbrowser 且正在运行；否则先 `ask_user`。详见 `web-research`。）

## 提示
- 脚本与中间数据放会话**沙盘**；用 `Bash` 运行（沙盘 cwd）。
- 需登录的站点：持久化 profile 已带登录态，`chapi_browser` 自动复用。
- **单驱动**：同一时刻只一个脚本能驱动浏览器（已加跨进程 CDP 锁，多个子代理会自动排队串行）。要同时看两个页面就在**一个脚本**里 `new_tab` 开第二个标签（最多 2），别派两个子代理各自连浏览器。并行只适合**不涉及浏览器**的独立工作。
- 找到后台 JSON 接口更稳更快：L0/L1 直接用 HTTP 调；L2/L3 **仍要经 cloakbrowser 的页面发起**（`page.request` / 在页面里 fetch），并保持低频。
- 报错/不熟的库：用 context7/WebFetch 查文档再改。
