# 技能：批量任务优先写脚本（高效处理）

## 何时使用
- 多页抓取、逐条进详情页、对大量条目做同样处理等**重复性/批量**工作。
- 一个个手动点击/翻页太慢且易错——**优先写脚本自动化**。

## 流程（务必按此走，全程**拟人**）
1. **先跑通一次（拟人探索）**：用 `chapi_browser` 像真人一样走一遍——先暖身首页、点进列表、再点进详情，摸清结构、翻页方式、详情字段。探索本身就要随机停顿、顺路径走，**别冷 goto 详情页**。
2. **写脚本**：在沙盘写 Python，用 `chapi_browser` + `human_*` 助手实现“顺路径点进 + 提取 + 翻页”，每步随机停顿、顺序低速。
3. **小批测试**：先跑**几页（如 3 页）**，从中**随机抽 ~5 条**核对结果，而不是按固定条数跑。
4. **全量运行**：没问题再全量；**全程保持随机停顿，宁慢勿被封**。有问题先改脚本再测。
5. **抽查验收**：用**抽样核对 / 核对数量 / 筛查异常值**验收，**不要逐条肉眼看**。
6. **交付**：优先 Google Sheet/Drive，`save_artifact`。

## ⚠️ 必须经 cloakbrowser + 模拟真人（否则触发 Akamai 封锁、还会把浏览器 CPU 拖垮）
裸 `requests`/`httpx`/独立 playwright，或脚本跑太快/冷链接直达详情/循环猛刷，**都会被反爬封**，
而且 Akamai 挑战脚本会把 cloakbrowser CPU 拖满导致**卡死/打不开页面**。所以脚本联网一律用沙盘里的
**`chapi_browser`** 接管运行中的 cloakbrowser，并用 `human_*` 拟人操作；它已封装好正确连接、复用反检测内核 +
持久化登录态，**只关你开的页面、绝不关闭共享浏览器**。新开页面会自动出现在「实时浏览器」。

运行：`uv run --with playwright python 脚本.py`（connect_over_cdp 不需要 `playwright install`）。

示例（**顺路径点进**详情、随机停顿、顺序低速，落 CSV）：
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
- 找到后台 JSON 接口可更稳更快，但**仍要经 cloakbrowser 的页面发起**（`page.request` / 在页面里 fetch），并保持低频。
- 报错/不熟的库：用 context7/WebFetch 查文档再改。
