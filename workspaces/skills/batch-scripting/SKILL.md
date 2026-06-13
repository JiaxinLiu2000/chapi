# 技能：批量任务优先写脚本（高效处理）

## 何时使用
- 多页抓取、逐条进详情页、对大量条目做同样处理等**重复性/批量**工作。
- 一个个手动点击/翻页太慢且易错——**优先写脚本自动化**。

## 流程（务必按此走）
1. **先跑通一次**：用 `chapi_browser` 手动走一遍，摸清页面结构、翻页方式、详情页字段、以及最高效的抓取手段（`page.evaluate(...)` 看 DOM，或直接找后台接口——往往打接口比点页面快得多）。
2. **写脚本**：在会话沙盘写一个 Python 脚本，用 `chapi_browser` 驱动 cloakbrowser 实现翻页 + 进详情 + 提取 + 落 CSV/JSON。
3. **小批测试**：先只跑 **~10 条**，**随机抽查**结果是否符合要求。
4. **全量运行**：没问题再正式全量跑；有问题先改脚本再测。
5. **抽查验收**：跑完用**抽样核对 / 核对数量 / 筛查异常值**来验收，**不要逐条肉眼看**。
6. **交付**：整理结果后按规矩交付（优先 Google Sheet/Drive，`save_artifact`）。

## ⚠️ 脚本访问网站必须走 cloakbrowser（反反爬 + 可观察）
裸 `requests`/`httpx`/独立 playwright 直连**很容易被反爬识别**（平台的反检测内核在 cloakbrowser 里，绕过它就没用了）。
所以脚本联网一律用沙盘里的 **`chapi_browser`** 助手接管运行中的 cloakbrowser——它已封装好正确连接、
复用反检测内核 + 持久化登录态，并且**只关你开的页面、绝不关闭共享浏览器**。新开页面会**自动出现在右侧「实时浏览器」**。

运行：`uv run --with playwright python 脚本.py`（connect_over_cdp 不需要 `playwright install`）。

示例（翻页批量抓取，落 CSV）：
```python
import csv
from chapi_browser import connect

rows = []
with connect() as ctx:               # 持久化 profile（含登录态）
    page = ctx.new_page()
    for n in range(1, 11):           # 先只跑 ~10 页做测试
        page.goto(f"https://example.com/list?page={n}", wait_until="domcontentloaded")
        for card in page.locator("div.item").all():
            rows.append({
                "title": card.locator("h3").inner_text(),
                "price": card.locator(".price").inner_text(),
            })
    page.close()                     # 只关自己开的页面；别 ctx.close()/browser.close()

with open("out.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=["title", "price"]); w.writeheader(); w.writerows(rows)
print(f"抓到 {len(rows)} 条")
```
（前提：设置里已启用 cloakbrowser 且正在运行；否则先 `ask_user` 提示用户启用。详见 `web-research` 技能。）

## 提示
- 脚本与中间数据放会话**沙盘**；用 `Bash` 运行（在沙盘 cwd）。
- 需要登录态的站点：cloakbrowser 持久化 profile 已带登录态，`chapi_browser` 自动复用。
- 互不依赖的大批量可拆成多个分片，交给**并行子代理**各跑一段（各自 `chapi_browser` 新开页面，实时浏览器可分屏观察）；异步并行可用 `open_page_async`。
- 报错/不熟的库：用 context7/WebFetch 查文档再改。
