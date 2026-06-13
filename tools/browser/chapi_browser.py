"""
chapi_browser — drive the running cloakbrowser from sandbox scripts (over CDP).

为什么用它：本平台的浏览器是 cloakbrowser（反检测内核 + 持久化登录 profile）。脚本
要联网/抓取时，**必须接管这个正在运行的浏览器**，而不是另起一个裸 Playwright/requests
（那样会被反爬识别、也拿不到登录态）。本模块封装了正确、安全的接管方式，省去每次手写
connect_over_cdp 的样板，并且**绝不关闭共享浏览器**（只关你自己开的页面）。

快速上手（同步）：
    from chapi_browser import open_page

    with open_page("https://example.com") as page:
        page.wait_for_load_state("networkidle")
        print(page.title())
        html = page.content()
    # 退出 with 时只关掉这个新页面；共享 cloakbrowser 继续运行。

多页 / 批量（同步）：
    from chapi_browser import connect

    with connect() as ctx:          # ctx = 持久化 profile（含登录态）
        p1 = ctx.new_page(); p1.goto("https://a.com")
        p2 = ctx.new_page(); p2.goto("https://b.com")
        ...
        p1.close(); p2.close()      # 关掉你开的页面，别关 ctx / browser

异步（适合并行）：
    import asyncio
    from chapi_browser import open_page_async

    async def main():
        async with open_page_async("https://example.com") as page:
            print(await page.title())
    asyncio.run(main())

运行脚本：
    uv run --with playwright python your_script.py
（connect_over_cdp 只需 playwright 这个 Python 包，**不需要** `playwright install` 下载内核，
 因为我们连的是已经在跑的 cloakbrowser。）

新开的页面会自动出现在网页右侧的「实时浏览器」面板，用户可实时观察脚本执行。

自检连接：
    uv run --with playwright python chapi_browser.py https://example.com
"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager, contextmanager

# 服务端在运行脚本时注入；默认本机 9222。
CDP_ENDPOINT = os.environ.get("CHAPI_CDP_ENDPOINT", "http://127.0.0.1:9222")

_NO_CONTEXT_MSG = (
    "cloakbrowser 已连接但没有可用的上下文（contexts 为空）。请确认浏览器已在设置中启用并已就绪；"
    "不要在脚本里 browser.close() 或 context.close()。"
)


def _pick_context(browser):
    """Return the persistent default context (carries the saved logins).

    With launch_persistent_context the default context is contexts[0]. We never
    create a fresh context here — a new context would be a clean profile without
    the user's logins, which defeats the purpose.
    """
    ctxs = browser.contexts
    if not ctxs:
        raise RuntimeError(_NO_CONTEXT_MSG)
    return ctxs[0]


@contextmanager
def connect(*, default_timeout_ms: int = 45000):
    """接管运行中的 cloakbrowser，产出其持久化 BrowserContext（含登录态）。

    你可以在其中 `ctx.new_page()` 开任意多页。**只关你自己开的页面**，不要关 ctx 或 browser
    （default context 不允许关闭，browser.close() 会断开连接并清空已开页面）。退出 with 时
    只断开 CDP 连接，cloakbrowser 进程继续运行。
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
        # 注意：不 browser.close()、不 ctx.close()。退出 sync_playwright 仅断开 CDP。


@contextmanager
def open_page(url: str | None = None, *, wait_until: str = "domcontentloaded", timeout_ms: int = 45000):
    """在 cloakbrowser 里新开 **一个** 页面并产出该 Page；退出时只关这个页面。

    传入 url 则自动 goto。这是最常用的入口：抓单页、做一次交互、截图等。
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
                page.goto(url, wait_until=wait_until, timeout=timeout_ms)
            yield page
        finally:
            try:
                page.close()
            except Exception:
                pass
            # 只关页面，不动共享 browser/context。


@asynccontextmanager
async def connect_async(*, default_timeout_ms: int = 45000):
    """connect() 的异步版本（适合并行多页）。"""
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
                await page.goto(url, wait_until=wait_until, timeout=timeout_ms)
            yield page
        finally:
            try:
                await page.close()
            except Exception:
                pass


def fetch_html(url: str, *, wait_until: str = "domcontentloaded", timeout_ms: int = 45000) -> str:
    """便捷函数：打开 url、返回渲染后的 HTML，自动关页面。"""
    with open_page(url, wait_until=wait_until, timeout_ms=timeout_ms) as page:
        return page.content()


if __name__ == "__main__":
    # 自检：连接 + 开页 + 打印标题。用法：python chapi_browser.py [url]
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
