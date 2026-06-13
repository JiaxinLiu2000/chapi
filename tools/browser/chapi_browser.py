"""
chapi_browser — 用 cloakbrowser **像真人一样**浏览网页（over CDP）。

⚠️ 关键：接管 cloakbrowser 时**复用它已有的持久化页面 `ctx.pages[0]`，不要 `new_page()`**。
经 CDP 新开的页面无法正常导航（goto 会卡到超时，连 example.com 都打不开）；复用默认页则秒开。
本模块的 `open_page()` / `connect()` 已经帮你复用默认页，照用即可。

⚠️ 反爬（Akamai/PerimeterX 等）主要靠**行为**识别：
  1. **始终经 cloakbrowser**（本模块即接管运行中的 cloakbrowser，别另起浏览器、别裸 requests）。
  2. **像真人一样**：动作间随机停顿、滚动、移动鼠标（`human_*` 助手），不要瞬间连点。
  3. **顺网站路径走**：先开首页/列表/搜索，再 **点进** 详情；**绝不冷 goto 深层详情 URL**。
  4. **翻页点“下一页”按钮**（用 `click_next(page)`），**不要直接拼 `?page=2` 冷跳**——很多站点会因此封锁。
  5. **节流低并发**：同一站点一个页面顺序慢走，循环里必有随机停顿。
  以上**探索阶段和正式脚本都适用**。

快速上手（同步）：
    from chapi_browser import open_page, warmup, human_click, human_scroll, human_pause, click_next

    with open_page() as page:                  # 复用默认页（退出时自动回到空白页）
        warmup(page, "https://site.com/")       # 先暖身首页
        human_click(page, "text=Listings")      # 点进列表
        while True:
            human_scroll(page)
            for link in page.locator("a.detail").all():
                human_click(page, link)          # 点进详情，而不是冷 goto
                ...抓取...
                page.go_back(); human_pause()
            if not click_next(page):             # 点“下一页”，没有就结束
                break

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
_BLANK = "about:blank"


# ───────────────────────── 拟人操作助手（同步） ─────────────────────────

def human_pause(min_s: float = 0.6, max_s: float = 2.4) -> None:
    """随机停顿 min_s~max_s 秒（动作之间务必调用，模拟真人节奏）。"""
    time.sleep(random.uniform(min_s, max_s))


def _viewport(page) -> tuple[int, int]:
    try:
        vp = page.viewport_size
        if vp and vp.get("width") and vp.get("height"):
            return int(vp["width"]), int(vp["height"])
    except Exception:
        pass
    return 1280, 800


def human_mouse(page, moves: int | None = None) -> None:
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
    """像真人一样打开一个**入口页**（首页/列表/搜索），导航后随机停顿、动一下鼠标。
    详情页请用 human_click 点进去，不要冷 goto。"""
    page.goto(url, wait_until=wait_until)
    human_pause(*settle)
    human_mouse(page)


def human_click(page, target, *, settle: tuple[float, float] = (1.0, 2.6)):
    """拟人点击：滚动到可见 → 悬停 → 短暂停顿 → 点击 → 随机停顿。用它点进链接/详情，而非冷 goto。"""
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
    """拟人输入：聚焦后逐字敲入（带随机字间延迟）。"""
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
    """先访问站点首页“暖身”（建立 cookie/会话轨迹）再做正事——很多反爬站直接打深层页会封。"""
    human_goto(page, home_url, settle=(1.5, 3.5))
    human_scroll(page, steps=random.randint(1, 3))
    human_pause(0.8, 2.0)


# 常见“下一页”选择器（顺序尝试）
_NEXT_SELECTORS = [
    "a[rel='next']",
    "[aria-label='Next' i]", "[aria-label*='next page' i]", "[aria-label*='下一页']",
    "a:has-text('下一页')", "button:has-text('下一页')",
    "a:has-text('Next')", "button:has-text('Next')",
    "[data-testid*='next' i]", "a.next", ".pagination-next a", "li.next a",
]


def click_next(page) -> bool:
    """点击“下一页”按钮（按真人方式），成功返回 True。**优先用它翻页，别拼 ?page=N 冷跳。**"""
    for sel in _NEXT_SELECTORS:
        try:
            loc = page.locator(sel).first
            if loc.count() and loc.is_visible() and loc.is_enabled():
                human_click(page, loc)
                return True
        except Exception:
            continue
    return False


def wait_for_any(page, selectors, timeout_ms: int = 15000):
    """等待若干候选选择器中任意一个出现（搜索框常是延迟/封装加载的），返回首个可见 Locator 或 None。"""
    deadline = time.time() + timeout_ms / 1000
    sels = [selectors] if isinstance(selectors, str) else list(selectors)
    while time.time() < deadline:
        for sel in sels:
            try:
                loc = page.locator(sel).first
                if loc.count() and loc.is_visible():
                    return loc
            except Exception:
                pass
        time.sleep(0.5)
    return None


# ───────────────────────── 接管 cloakbrowser（同步） ─────────────────────────

def _pick_context(browser):
    ctxs = browser.contexts
    if not ctxs:
        raise RuntimeError(_NO_CONTEXT_MSG)
    return ctxs[0]


def active_page(ctx):
    """返回可用的默认页（复用 ctx.pages[0]）；没有才新建。**优先复用，别 new_page()。**"""
    return ctx.pages[0] if ctx.pages else ctx.new_page()


@contextmanager
def connect(*, default_timeout_ms: int = 45000):
    """接管运行中的 cloakbrowser，产出持久化 BrowserContext（含登录态）。

    在其中**复用 `ctx.pages[0]`**（用 `active_page(ctx)`）；CDP 下 `new_page()` 往往无法导航。
    退出 with 只断开 CDP，不关 browser/context。
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


@contextmanager
def open_page(url: str | None = None, *, wait_until: str = "domcontentloaded", timeout_ms: int = 45000):
    """复用 cloakbrowser 的默认页并产出该 Page。**退出时把页面导回空白页**（闲置即空白）。

    传 url 会用 human_goto 拟人打开（仅传**入口页**；详情页用 human_click 点进）。
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser = pw.chromium.connect_over_cdp(CDP_ENDPOINT)
        ctx = _pick_context(browser)
        created = not ctx.pages
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
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
                if created:
                    page.close()
                else:
                    page.goto(_BLANK)  # 回到空白页 → 实时浏览器视为闲置
            except Exception:
                pass


def fetch_html(url: str, *, wait_until: str = "domcontentloaded", timeout_ms: int = 45000) -> str:
    """便捷函数：拟人打开 url、返回渲染后的 HTML，结束后页面回到空白页。"""
    with open_page(url, wait_until=wait_until, timeout_ms=timeout_ms) as page:
        return page.content()


# ───────────────────────── 异步版本（同样复用默认页） ─────────────────────────

async def human_pause_async(min_s: float = 0.6, max_s: float = 2.4) -> None:
    await asyncio.sleep(random.uniform(min_s, max_s))


async def human_goto_async(page, url: str, *, wait_until: str = "domcontentloaded", settle: tuple[float, float] = (1.2, 3.0)) -> None:
    await page.goto(url, wait_until=wait_until)
    await human_pause_async(*settle)


@asynccontextmanager
async def open_page_async(url: str | None = None, *, wait_until: str = "domcontentloaded", timeout_ms: int = 45000):
    """open_page() 的异步版本（复用默认页；浏览器任务建议顺序执行，CDP 多页并发不可靠）。"""
    from playwright.async_api import async_playwright

    async with async_playwright() as pw:
        browser = await pw.chromium.connect_over_cdp(CDP_ENDPOINT)
        ctxs = browser.contexts
        if not ctxs:
            raise RuntimeError(_NO_CONTEXT_MSG)
        ctx = ctxs[0]
        created = not ctx.pages
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
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
                if created:
                    await page.close()
                else:
                    await page.goto(_BLANK)
            except Exception:
                pass


if __name__ == "__main__":
    # 自检：连接 + 复用默认页 + 打印标题。用法：python chapi_browser.py [url]
    import sys

    target = sys.argv[1] if len(sys.argv) > 1 else "https://example.com"
    print(f"[chapi_browser] CDP={CDP_ENDPOINT} -> {target}", flush=True)
    try:
        with open_page(target) as page:
            page.wait_for_load_state("load")
            print(f"[chapi_browser] OK title={page.title()!r} url={page.url}", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"[chapi_browser] FAILED: {e}", flush=True)
        sys.exit(1)
