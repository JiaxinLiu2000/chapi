"""
chapi_browser — 用 cloakbrowser **像真人一样**浏览网页（over CDP）。

⚠️ 反爬（Akamai 等）主要靠**行为**识别机器人，不只是指纹。所以：
  1. **始终通过 cloakbrowser**（本模块就是接管正在运行的 cloakbrowser，别另起浏览器、别用裸 requests）。
  2. **像真人一样操作**：动作之间**随机停顿**、滚动浏览、移动鼠标，不要瞬间连点。
  3. **顺着网站自己的路径走**：先打开首页/列表/搜索页，再**点进**详情页；
     **绝不要直接 goto 一个深层详情页 URL**（无来源的冷链接最容易触发封锁）。
  4. **节流 + 低并发**：同一站点用**一个页面顺序**慢慢走，不要并发猛刷；循环里务必有随机停顿。
  以上规则**写脚本前的探索阶段同样适用**——探索也要像真人。

为什么用它：cloakbrowser 是反检测内核 + 持久化登录 profile，始终在后台运行。本模块封装了
正确的接管方式（只关你自己开的页面、**绝不关闭共享浏览器**）和一套**拟人操作**助手。

快速上手（同步，单页 + 拟人）：
    from chapi_browser import open_page, human_goto, human_click, human_scroll, human_pause

    with open_page() as page:                 # 开一个新页（会显示在实时浏览器）
        human_goto(page, "https://site.com/")  # 先到首页，带随机停顿
        human_scroll(page)                     # 滚动浏览一下
        human_click(page, "text=Listings")     # 点进列表（不是直接 goto 详情）
        human_pause()
        for card in page.locator(".item").all():
            human_click(page, card.locator("a.detail"))  # 点进详情
            ...抓取...
            page.go_back(); human_pause()
    # 退出时只关这个页面；cloakbrowser 继续运行。

运行脚本：
    uv run --with playwright python your_script.py
（connect_over_cdp 只需 playwright 包，不需要 `playwright install`。）

自检：
    uv run --with playwright python chapi_browser.py https://example.com
"""
from __future__ import annotations

import asyncio
import os
import random
import time
from contextlib import asynccontextmanager, contextmanager

# 服务端运行脚本时注入；默认本机 9222。
CDP_ENDPOINT = os.environ.get("CHAPI_CDP_ENDPOINT", "http://127.0.0.1:9222")

_NO_CONTEXT_MSG = (
    "cloakbrowser 已连接但没有可用的上下文（contexts 为空）。请确认浏览器已在设置中启用并已就绪；"
    "不要在脚本里 browser.close() 或 context.close()。"
)


# ───────────────────────── 拟人操作助手（同步） ─────────────────────────

def human_pause(min_s: float = 0.6, max_s: float = 2.4) -> None:
    """随机停顿 min_s~max_s 秒（动作之间务必调用，模拟真人节奏）。"""
    time.sleep(random.uniform(min_s, max_s))


def _viewport(page) -> tuple[int, int]:
    vp = None
    try:
        vp = page.viewport_size
    except Exception:
        vp = None
    if vp and vp.get("width") and vp.get("height"):
        return int(vp["width"]), int(vp["height"])
    return 1280, 800


def human_mouse(page, moves: int | None = None) -> None:
    """随机移动几下鼠标（真人不会光标不动）。"""
    w, h = _viewport(page)
    for _ in range(moves or random.randint(1, 3)):
        try:
            page.mouse.move(random.randint(0, w), random.randint(0, h), steps=random.randint(6, 18))
        except Exception:
            return
        time.sleep(random.uniform(0.1, 0.4))


def human_scroll(page, steps: int | None = None) -> None:
    """分几次、带停顿地向下滚动浏览（像真人在读内容）。"""
    for _ in range(steps or random.randint(2, 5)):
        try:
            page.mouse.wheel(0, random.randint(300, 800))
        except Exception:
            return
        human_pause(0.4, 1.3)


def human_goto(page, url: str, *, wait_until: str = "domcontentloaded", settle: tuple[float, float] = (1.2, 3.0)) -> None:
    """像真人一样打开一个 URL：导航后随机停顿“看一眼”，并动一下鼠标。

    注意：这适合打开**入口页**（首页/列表/搜索）。详情页请用 human_click **点进去**，不要冷 goto。
    """
    page.goto(url, wait_until=wait_until)
    human_pause(*settle)
    human_mouse(page)


def human_click(page, target, *, settle: tuple[float, float] = (1.0, 2.6)):
    """拟人点击：滚动到可见 → 悬停 → 短暂停顿 → 点击 → 随机停顿。

    target 可以是 CSS/文本选择器字符串，或一个 Locator。返回该 Locator。
    用它**点进链接/详情页**，而不是直接 goto 深层 URL。
    """
    loc = page.locator(target) if isinstance(target, str) else target
    try:
        loc.scroll_into_view_if_needed(timeout=8000)
    except Exception:
        pass
    human_pause(0.3, 0.9)
    try:
        loc.hover(timeout=8000)
        human_pause(0.2, 0.7)
    except Exception:
        pass
    loc.click()
    human_pause(*settle)
    return loc


def human_type(page, target, text: str, *, settle: tuple[float, float] = (0.4, 1.2)):
    """拟人输入：聚焦后逐字敲入（带随机字间延迟），而非瞬间填充。"""
    loc = page.locator(target) if isinstance(target, str) else target
    try:
        loc.scroll_into_view_if_needed(timeout=8000)
        loc.click()
    except Exception:
        pass
    human_pause(0.2, 0.6)
    loc.type(text, delay=random.uniform(60, 160))
    human_pause(*settle)
    return loc


def warmup(page, home_url: str) -> None:
    """先访问站点首页“暖身”：建立 cookie/会话、随机停顿、滚动，再去做正事。

    很多 Akamai 站点要求先有正常的首页访问轨迹，直接打深层页极易被封。
    """
    human_goto(page, home_url, settle=(1.5, 3.5))
    human_scroll(page, steps=random.randint(1, 3))
    human_pause(0.8, 2.0)


# ───────────────────────── 接管 cloakbrowser（同步） ─────────────────────────

def _pick_context(browser):
    """Return the persistent default context (carries the saved logins).

    With launch_persistent_context the default context is contexts[0]. We never
    create a fresh context — a clean context loses the user's logins.
    """
    ctxs = browser.contexts
    if not ctxs:
        raise RuntimeError(_NO_CONTEXT_MSG)
    return ctxs[0]


@contextmanager
def connect(*, default_timeout_ms: int = 45000):
    """接管运行中的 cloakbrowser，产出其持久化 BrowserContext（含登录态）。

    在其中 `ctx.new_page()` 开页面。**只关你自己开的页面**，不要关 ctx 或 browser。
    退出 with 仅断开 CDP 连接，cloakbrowser 进程继续运行。
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser = pw.chromium.connect_over_cdp(CDP_ENDPOINT)
        ctx = _pick_context(browser)
        try:
            ctx.set_default_timeout(default_timeout_ms)
        except Exception:
            pass
        yield ctx
        # 不 browser.close()、不 ctx.close()。


@contextmanager
def open_page(url: str | None = None, *, wait_until: str = "domcontentloaded", timeout_ms: int = 45000):
    """在 cloakbrowser 里新开 **一个** 页面并产出该 Page；退出时只关这个页面。

    传 url 会用 human_goto 拟人打开（带随机停顿）。**只把入口页传进来**，详情页请 human_click 点进。
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser = pw.chromium.connect_over_cdp(CDP_ENDPOINT)
        ctx = _pick_context(browser)
        page = ctx.new_page()
        try:
            page.set_default_timeout(timeout_ms)
        except Exception:
            pass
        try:
            if url:
                human_goto(page, url, wait_until=wait_until)
            yield page
        finally:
            try:
                page.close()
            except Exception:
                pass


def fetch_html(url: str, *, wait_until: str = "domcontentloaded", timeout_ms: int = 45000) -> str:
    """便捷函数：拟人打开 url、返回渲染后的 HTML，自动关页面。"""
    with open_page(url, wait_until=wait_until, timeout_ms=timeout_ms) as page:
        return page.content()


# ───────────────────────── 异步版本 ─────────────────────────

async def human_pause_async(min_s: float = 0.6, max_s: float = 2.4) -> None:
    await asyncio.sleep(random.uniform(min_s, max_s))


async def human_goto_async(page, url: str, *, wait_until: str = "domcontentloaded", settle: tuple[float, float] = (1.2, 3.0)) -> None:
    await page.goto(url, wait_until=wait_until)
    await human_pause_async(*settle)


@asynccontextmanager
async def connect_async(*, default_timeout_ms: int = 45000):
    """connect() 的异步版本（并行多目标时用；同一站点请勿高并发）。"""
    from playwright.async_api import async_playwright

    async with async_playwright() as pw:
        browser = await pw.chromium.connect_over_cdp(CDP_ENDPOINT)
        ctxs = browser.contexts
        if not ctxs:
            raise RuntimeError(_NO_CONTEXT_MSG)
        ctx = ctxs[0]
        try:
            ctx.set_default_timeout(default_timeout_ms)
        except Exception:
            pass
        yield ctx


@asynccontextmanager
async def open_page_async(url: str | None = None, *, wait_until: str = "domcontentloaded", timeout_ms: int = 45000):
    """open_page() 的异步版本。"""
    from playwright.async_api import async_playwright

    async with async_playwright() as pw:
        browser = await pw.chromium.connect_over_cdp(CDP_ENDPOINT)
        ctxs = browser.contexts
        if not ctxs:
            raise RuntimeError(_NO_CONTEXT_MSG)
        page = await ctxs[0].new_page()
        try:
            page.set_default_timeout(timeout_ms)
        except Exception:
            pass
        try:
            if url:
                await human_goto_async(page, url, wait_until=wait_until)
            yield page
        finally:
            try:
                await page.close()
            except Exception:
                pass


if __name__ == "__main__":
    # 自检：连接 + 拟人开页 + 打印标题。用法：python chapi_browser.py [url]
    import sys

    target = sys.argv[1] if len(sys.argv) > 1 else "https://example.com"
    print(f"[chapi_browser] CDP={CDP_ENDPOINT} → {target}", flush=True)
    try:
        with open_page(target) as page:
            page.wait_for_load_state("load")
            print(f"[chapi_browser] OK title={page.title()!r} url={page.url}", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"[chapi_browser] FAILED: {e}", flush=True)
        sys.exit(1)
