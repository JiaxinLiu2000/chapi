# 技能：批量任务优先写脚本（高效处理）

## 何时使用
- 多页抓取、逐条进详情页、对大量条目做同样处理等**重复性/批量**工作。
- 一个个手动点击/翻页太慢且易错——**优先写脚本自动化**。

## 流程（务必按此走）
1. **先跑通一次**：用浏览器/工具手动走一遍，摸清页面结构、翻页方式、详情页字段、以及最高效的抓取手段（可用 `browser_evaluate` 看 DOM 或后台接口，往往直接打接口比点页面快得多）。
2. **写脚本**：在会话沙盘写一个 Python 脚本（`requests`/`httpx`/`beautifulsoup4`，或通过 CDP 驱动 cloakbrowser）实现翻页 + 进详情 + 提取 + 落 CSV/JSON。
3. **小批测试**：先只跑 **~10 条**，**随机抽查**结果是否符合要求。
4. **全量运行**：没问题再正式全量跑；有问题先改脚本再测。
5. **抽查验收**：跑完用**抽样核对 / 核对数量 / 筛查异常值**来验收，**不要逐条肉眼看**。
6. **交付**：整理结果后按规矩交付（优先 Google Sheet/Drive，`save_artifact`）。

## ⚠️ 脚本访问网站必须走 cloakbrowser（反反爬 + 可观察）
普通 `requests`/`httpx`/裸 playwright 直连**很容易被反爬虫识别**（本平台的浏览器是 cloakbrowser 反检测内核，但脚本绕过它就没用了）。所以脚本要联网时：
- **连到正在运行的 cloakbrowser（CDP 端点 `http://127.0.0.1:9222`）并新开页面执行**，复用它的反检测内核 + 持久化登录态。新开的页面会**自动出现在右侧「实时浏览器」**，用户可实时观察脚本执行。
- 不要在脚本里另起一个独立浏览器（会和运行中的实例/profile 冲突），也不要用裸 HTTP 抓受保护站点。
- 运行：`uv run --with playwright python 脚本.py`（playwright 用于 connect_over_cdp；cloakbrowser 本身已在跑）。

示例（Python）：
```python
from playwright.sync_api import sync_playwright
with sync_playwright() as pw:
    browser = pw.chromium.connect_over_cdp("http://127.0.0.1:9222")  # 接管运行中的 cloakbrowser
    ctx = browser.contexts[0]            # 复用持久化 profile（含登录态）
    page = ctx.new_page()                # 新页面 → 会显示在实时浏览器
    page.goto("https://example.com/list?page=1")
    # ...翻页/进详情/提取，落 CSV/JSON 到沙盘...
    page.close()
```
（前提：设置里已启用 cloakbrowser 且正在运行；否则先提示用户启用。）

## 提示
- 脚本与中间数据放会话**沙盘**；用 `Bash` 运行（在沙盘 cwd）。
- 需要登录态的站点：cloakbrowser 持久化 profile 已带登录态，connect_over_cdp 后直接复用（见 web-research）。
- 互不依赖的大批量可拆成多个分片，交给**并行子代理**各跑一段（各自新开页面，实时浏览器可分屏观察）。
- 报错/不熟的库：用 context7/WebFetch 查文档再改。
