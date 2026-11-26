"""
chapi_browser — 用 cloakbrowser **像真人一样**浏览网页（over CDP）。

⚠️ 关键 1（单驱动）：**同一时刻只能有一个脚本驱动 cloakbrowser**。本模块对 `connect()`/`open_page()`
加了**跨进程 CDP 锁**：两个子代理同时连会自动排队（不再握手踩踏卡死）。所以"两个子代理各开一个网站"
能跑，但会**串行**。要真正"同时看两个页面"，请在**同一个脚本/连接**里用 `new_tab()` 多开（最多 2 个）。

⚠️ 关键 2（开标签的方式）：单页任务复用 `ctx.pages[0]`（`active_page(ctx)` / `open_page()` 已帮你做）。
要多开标签**必须用 `new_tab()`**（内部走 `window.open` 弹原生标签）；**别直接 `ctx.new_page()`**——
CDP 下它建的标签拿不到渲染进程，goto 永远卡在 commit（连 example.com 都打不开）。这与并发无关。
（清残留标签：`GET http://127.0.0.1:<port>/json/close/{targetId}`。）

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

Google 拟人搜索（每次联网查资料都用它，至少看 2 页）：
    from chapi_browser import open_page, google_search
    with open_page() as page:
        results = google_search(page, "1133 S Hope St Los Angeles units", pages=2)
    # 或命令行：uv run --with playwright python chapi_browser.py google "query1" "query2" --pages 2 --json serp.json

用户本机 Chrome 的已有登录（**默认关闭**；仅当对话顶部勾选了「用我的 Chrome」才可用，否则抛 PermissionError）：
    from chapi_browser import open_chrome_page, chrome_tabs
    with open_chrome_page("https://需登录的网址") as page:   # 默认 jiaxin.liu@unitpulse.ai 配置，后台新标签
        print(page.title())
    with open_chrome_page(use_tab="docs.google.com/spreadsheets/d/xxx") as page:  # 读用户已开的标签
        ...
"""
from __future__ import annotations

import asyncio
import os
import random
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager, contextmanager

# 服务端运行脚本时注入；默认本机 9222。
CDP_ENDPOINT = os.environ.get("CHAPI_CDP_ENDPOINT", "http://127.0.0.1:9222")
# chapi 自己的 HTTP API；服务端运行脚本时注入，默认本机 8123。
SERVER_URL = os.environ.get("CHAPI_SERVER_URL", "http://127.0.0.1:8123")

_NO_CONTEXT_MSG = (
    "cloakbrowser 已连接但没有可用的上下文（contexts 为空）。请确认浏览器已在设置中启用并已就绪；"
    "不要在脚本里 browser.close() 或 context.close()。"
)
_BLANK = "about:blank"
_CONNECT_TIMEOUT_MS = 30000  # 别用 Playwright 默认的 180s——失败要快、好重试
_LOCK_STALE_S = 90           # 锁持有者每 30s 心跳；超过这个没动静视为崩溃残留


def _lock_path() -> str:
    """所有 chapi_browser 进程共享的同一把锁文件（按 CDP 端口区分）。"""
    p = os.environ.get("CHAPI_BROWSER_LOCK")
    if p:
        return p
    port = CDP_ENDPOINT.rsplit(":", 1)[-1].split("/")[0] or "9222"
    return os.path.join(tempfile.gettempdir(), f"chapi-cdp-{port}.lock")


class _CdpLock:
    """跨进程文件锁：同一时刻只允许一个 CDP 驱动会话连 cloakbrowser，其余排队。

    解决并发踩踏——两个子代理同时 connect_over_cdp 会卡死握手。拿不到锁就阻塞等待，
    崩溃残留的锁通过心跳时间戳自动判定为过期并夺取。
    """

    def __init__(self, path: str | None = None) -> None:
        self.path = path or _lock_path()
        self.fd: int | None = None
        self._stop: threading.Event | None = None

    def acquire(self, timeout_s: float = 600.0) -> None:
        deadline = time.time() + timeout_s
        while True:
            try:
                self.fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_RDWR)
                os.write(self.fd, f"{os.getpid()} {time.time()}".encode())
                self._start_heartbeat()
                return
            except FileExistsError:
                try:
                    if time.time() - os.path.getmtime(self.path) > _LOCK_STALE_S:
                        os.remove(self.path)
                        continue
                except FileNotFoundError:
                    continue
                if time.time() > deadline:
                    raise TimeoutError("另一个浏览器会话正持有 CDP 锁（等待超时）")
                time.sleep(0.5)

    def _start_heartbeat(self) -> None:
        self._stop = threading.Event()
        stop = self._stop
        path = self.path

        def beat() -> None:
            while not stop.wait(30):
                try:
                    os.utime(path, None)
                except Exception:
                    pass

        threading.Thread(target=beat, daemon=True).start()

    def release(self) -> None:
        if self._stop:
            self._stop.set()
        if self.fd is not None:
            try:
                os.close(self.fd)
            except Exception:
                pass
            self.fd = None
        try:
            os.remove(self.path)
        except Exception:
            pass


@contextmanager
def _hold_lock():
    lk = _CdpLock()
    lk.acquire()
    try:
        yield
    finally:
        lk.release()


def _cdp_reachable() -> bool:
    try:
        urllib.request.urlopen(f"{CDP_ENDPOINT}/json/version", timeout=1.5)
        return True
    except Exception:  # noqa: BLE001
        return False


def _ensure_browser_running() -> None:
    """cloakbrowser 可能在"启用"之后的任意时刻自己挂了（用户关掉了可见的窗口、
    崩溃、机器休眠……），而这之后没有任何东西会自动发现并重启它——直到某个脚本
    尝试连接才会发现连不上。这里主动喊一声 chapi 服务端把它拉起来，再等它就绪，
    而不是直接连接失败。"""
    if _cdp_reachable():
        return
    try:
        req = urllib.request.Request(
            f"{SERVER_URL}/api/browser/start",
            method="POST",
            data=b"{}",
            headers={"content-type": "application/json"},
        )
        urllib.request.urlopen(req, timeout=5)
    except Exception:  # noqa: BLE001
        pass  # 尽力而为；就算这一下没喊通，下面还是会照常重试连接
    # 首次可能要下载内核（~200MB），给够时间再放弃，让下面的连接重试给出真正的错误。
    for _ in range(45):
        if _cdp_reachable():
            return
        time.sleep(2.0)


def _connect_cdp(pw):
    """connect_over_cdp + 短超时 + 有限重试（默认 180s 太慢）。"""
    _ensure_browser_running()
    last: Exception | None = None
    for attempt in range(3):
        try:
            return pw.chromium.connect_over_cdp(CDP_ENDPOINT, timeout=_CONNECT_TIMEOUT_MS)
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.0 * (attempt + 1))
    raise last if last else RuntimeError("connect_over_cdp failed")


def _reset_autoattach(browser) -> None:
    """Turn OFF browser-wide auto-attach before disconnecting.

    connect_over_cdp makes Playwright enable Target.setAutoAttach with
    waitForDebuggerOnStart=true — so every NEW tab/navigation is frozen until the
    debugger resumes it. If we disconnect (or just sit idle) leaving that on, the
    user's MANUAL browsing hangs forever on "loading". Clearing it leaves the shared
    browser usable by hand.
    """
    try:
        s = browser.new_browser_cdp_session()
        s.send("Target.setAutoAttach", {"autoAttach": False, "waitForDebuggerOnStart": False, "flatten": True})
    except Exception:
        pass


async def _reset_autoattach_async(browser) -> None:
    try:
        s = await browser.new_browser_cdp_session()
        await s.send("Target.setAutoAttach", {"autoAttach": False, "waitForDebuggerOnStart": False, "flatten": True})
    except Exception:
        pass


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


# ───────────────────────── Google 拟人搜索 ─────────────────────────

class GoogleCaptcha(RuntimeError):
    """Google 弹出了人机验证（/sorry/ 页）。请 ask_user 让用户在实时浏览器里手动完成验证后再重试。"""


_GOOGLE_HOME = "https://www.google.com/?hl={hl}"
_GOOGLE_BOX = ["textarea[name='q']", "input[name='q']"]
_GOOGLE_CONSENT = ["#L2AGLb", "button:has-text('Accept all')", "button:has-text('Reject all')",
                   "button:has-text('全部接受')", "button:has-text('全部拒绝')"]
_GOOGLE_NEXT = ["a#pnnext", "a[aria-label='Next page']", "a[aria-label='下一页']"]
_GOOGLE_MORE = ["a[aria-label='More results']", "span:has-text('More results')", "span:has-text('更多结果')"]

# 从结果页提取自然结果：标题(h3) + 链接 + 摘要 + 摘要前缀里的日期（如 "Oct 3, 2026 — …"）
_GOOGLE_EXTRACT_JS = r"""
() => {
  const out = [];
  const seen = new Set();
  const root = document.querySelector('#rso') || document.querySelector('#search') || document.body;
  for (const h3 of root.querySelectorAll('a h3, h3 a')) {
    const a = h3.closest('a') || h3.querySelector('a');
    if (!a || !a.href) continue;
    let url = a.href;
    try {
      const u = new URL(url);
      if (u.pathname === '/url' && u.searchParams.get('q')) url = u.searchParams.get('q');
      if (/(^|\.)google\.[a-z.]+$/.test(new URL(url).hostname)) continue;
    } catch (e) { continue; }
    if (seen.has(url) || a.closest('#tads, #bottomads, [data-text-ad]')) continue;
    seen.add(url);
    const box = a.closest('div.g, div.MjjYud, div[data-hveid], div[data-sokoban-container]') || a.parentElement;
    const sn = box && box.querySelector('div.VwiC3b, [data-sncf], div[style*="line-clamp"], span.st');
    let snippet = sn ? sn.innerText : (box ? box.innerText.replace(h3.innerText, '') : '');
    snippet = snippet.replace(/\s+/g, ' ').replace(/\s*(Read more|更多内容)$/, '').trim().slice(0, 400);
    const dm = snippet.match(/^((?:[A-Z][a-z]{2} \d{1,2}, \d{4})|(?:\d{4}年\d{1,2}月\d{1,2}日)|(?:\d+ (?:minutes?|hours?|days?|weeks?) ago))\s*[—-]\s*/);
    out.push({ title: h3.innerText.trim(), url, snippet: dm ? snippet.slice(dm[0].length) : snippet, date: dm ? dm[1] : null });
  }
  return out;
}
"""


def _google_blocked(page) -> bool:
    try:
        if "/sorry/" in page.url:
            return True
        return bool(page.locator("form#captcha-form, iframe[src*='recaptcha']").count())
    except Exception:
        return False


def _google_dismiss_consent(page) -> None:
    for sel in _GOOGLE_CONSENT:
        try:
            loc = page.locator(sel).first
            if loc.count() and loc.is_visible():
                human_click(page, loc, settle=(0.8, 1.6))
                return
        except Exception:
            continue


def _google_click_first(page, selectors) -> bool:
    for sel in selectors:
        try:
            loc = page.locator(sel).first
            if loc.count() and loc.is_visible():
                human_click(page, loc, settle=(1.6, 3.2))
                return True
        except Exception:
            continue
    return False


def google_search(page, query: str, pages: int = 2, *, hl: str = "en") -> list[dict]:
    """在 cloakbrowser 里**像真人一样**用 Google 搜索并收集前 `pages` 页自然结果（默认 2 页）。

    流程：打开 google.com（已在 Google 就复用）→ 点搜索框 → 逐字输入 → 回车 → 滚动浏览 →
    提取结果 → 点"下一页"（或"More results"）→ 再提取。每步都有随机停顿。
    返回 [{rank, page, title, url, snippet, date}]（date 为摘要前缀里的发布日期，没有则 None，
    可作为 rate_sources 的 publishedAt 线索——以打开原文看到的日期为准）。
    遇到人机验证抛 GoogleCaptcha：请 ask_user 让用户在实时浏览器里完成验证，然后重试。
    """
    try:
        on_google = "google." in (page.url or "") and "/sorry/" not in page.url
    except Exception:
        on_google = False
    if not on_google:
        human_goto(page, _GOOGLE_HOME.format(hl=hl), settle=(1.2, 2.6))
        _google_dismiss_consent(page)
    if _google_blocked(page):
        raise GoogleCaptcha("Google 要求人机验证（/sorry/）——请让用户在实时浏览器里完成验证后重试")

    box = wait_for_any(page, _GOOGLE_BOX, timeout_ms=15000)
    if box is None:
        raise RuntimeError("找不到 Google 搜索框")
    human_click(page, box, settle=(0.3, 0.8))
    try:
        page.keyboard.press("Control+A")
        page.keyboard.press("Backspace")
    except Exception:
        pass
    box.type(query, delay=random.uniform(70, 170))
    human_pause(0.4, 1.1)
    page.keyboard.press("Enter")
    try:
        page.wait_for_selector("#search, #rso, form#captcha-form", timeout=20000)
    except Exception:
        pass
    human_pause(1.2, 2.6)

    results: list[dict] = []
    seen: set[str] = set()
    for pno in range(1, max(1, pages) + 1):
        if _google_blocked(page):
            raise GoogleCaptcha("Google 要求人机验证（/sorry/）——请让用户在实时浏览器里完成验证后重试")
        human_mouse(page)
        human_scroll(page, steps=random.randint(2, 4))
        for r in page.evaluate(_GOOGLE_EXTRACT_JS) or []:
            if r["url"] in seen:
                continue
            seen.add(r["url"])
            results.append({"rank": len(results) + 1, "page": pno, **r})
        if pno >= pages:
            break
        human_pause(1.0, 2.4)
        moved = _google_click_first(page, _GOOGLE_NEXT)
        if not moved:  # 部分地区是无限滚动 + "More results" 按钮
            human_scroll(page, steps=random.randint(3, 6))
            moved = _google_click_first(page, _GOOGLE_MORE)
        if not moved:
            break
    return results


def google_search_many(queries: list[str], pages: int = 2, *, hl: str = "en",
                       between: tuple[float, float] = (4.0, 9.0)) -> dict[str, list[dict]]:
    """依次（拟人、带停顿）搜索多个关键词，每个看 `pages` 页。返回 {query: results}。"""
    out: dict[str, list[dict]] = {}
    with open_page() as page:
        for i, q in enumerate(queries):
            if i:
                human_pause(*between)
            out[q] = google_search(page, q, pages, hl=hl)
    return out


# ───────────────────────── 接管 cloakbrowser（同步） ─────────────────────────

# ───────────────────────── Slack 只读守卫 ─────────────────────────
#
# chapi 对 Slack 只读：每次接管浏览器都在 Slack 的 Web API 请求上装拦截，凡是写操作
# （发/改/删消息、表情、上传、置顶、标为已读、加入/离开/邀请、草稿、提醒、改资料……）一律中止。
# 读取请走 chapi_slack.py（白名单）。断开连接后拦截随之失效，用户自己操作不受影响。

import re as _re

_SLACK_API_RE = _re.compile(r"^https://(?:[a-z0-9-]+\.)*slack\.com/api/([A-Za-z0-9_.]+)")
_SLACK_WRITE_FAMILIES = (
    "chat.", "reactions.", "pins.", "stars.", "bookmarks.", "reminders.", "drafts.", "calls.",
    "workflows.", "admin.", "saved.", "subscriptions.", "dnd.", "apps.", "huddles.",
)
_SLACK_WRITE_VERB = _re.compile(
    r"^(?:post|update|delete|remove|add|create|set|upload|mark|invite|kick|leave|join|archive|unarchive|"
    r"rename|share|unshare|schedule|complete|open|close|end|start|save|unsave|edit|send|unfurl|accept|"
    r"decline|approve|deny|revoke|enable|disable|publish|react|pin|unpin|star|unstar|snooze|dismiss|move|"
    r"convert|restore|submit|request|register|toggle|clear|hide|unhide|mute|unmute|follow|unfollow|"
    r"subscribe|unsubscribe|reply|forward|write|put|patch|record|trigger|execute|run)",
    _re.I,
)


def is_slack_write(method: str) -> bool:
    """Slack Web API 方法名是否属于写操作（保守判断：拿不准就算写）。"""
    m = (method or "").strip().lower()
    if not m:
        return False
    if m.startswith(_SLACK_WRITE_FAMILIES):
        return True
    return any(_SLACK_WRITE_VERB.match(part) for part in m.split(".")[1:])


def _log_blocked(method: str) -> None:
    try:
        print(f"[chapi_browser] 已拦截 Slack 写操作 {method}（chapi 对 Slack 只读）", flush=True)
    except Exception:  # noqa: BLE001  (e.g. non-UTF-8 console)
        print(f"[chapi_browser] BLOCKED Slack write {method} (Slack is read-only)", flush=True)


def _slack_route(route) -> None:
    m = _SLACK_API_RE.match(route.request.url)
    if m and is_slack_write(m.group(1)):
        route.abort("blockedbyclient")  # abort first: logging must never decide whether a write goes out
        _log_blocked(m.group(1))
    else:
        route.continue_()


async def _slack_route_async(route) -> None:
    m = _SLACK_API_RE.match(route.request.url)
    if m and is_slack_write(m.group(1)):
        await route.abort("blockedbyclient")
        _log_blocked(m.group(1))
    else:
        await route.continue_()


def guard_slack_writes(target) -> None:
    """在 BrowserContext 或 Page 上装 Slack 写操作拦截（connect/open_page/open_chrome_page 已自动调用）。"""
    try:
        target.route(_SLACK_API_RE, _slack_route)
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"Slack 只读拦截安装失败，已中止：{e}") from e


def _unguard(target) -> None:
    try:
        target.unroute_all(behavior="ignoreErrors")
    except Exception:  # noqa: BLE001
        pass


def _pick_context(browser):
    ctxs = browser.contexts
    if not ctxs:
        raise RuntimeError(_NO_CONTEXT_MSG)
    return ctxs[0]


def active_page(ctx):
    """返回可用的默认页（复用 ctx.pages[0]）；没有才新建。**单页任务优先复用。**"""
    return ctx.pages[0] if ctx.pages else ctx.new_page()


def new_tab(ctx, url: str | None = None, *, wait_until: str = "domcontentloaded"):
    """在**同一个连接**里多开一个标签页（同时浏览两个页面用，最多 2 个）。

    ⚠️ **不要用 `ctx.new_page()`**：cloakbrowser + CDP 下它创建的目标拿不到可用渲染进程，会"无法
    导航"（goto 永远卡在 commit，连 example.com 都打不开，重 JS 站还会被崩溃恢复关掉）。
    正确做法：从一个**已工作的页面**用 `window.open` 弹出**浏览器原生标签**（会过 cloak 反检测注入、
    分到渲染进程），再 `bring_to_front` 置前（防后台节流 + 让实时浏览器同屏显示）。
    仅在**一个** chapi_browser 会话内安全（持有 CDP 锁、独占驱动）；用完 `page.close()` 关掉它。
    """
    opener = ctx.pages[0] if ctx.pages else ctx.new_page()  # 默认页一直可用
    try:
        with ctx.expect_page(timeout=10000) as pinfo:  # 捕获弹出的新页（evaluate 不回传 Page）
            opener.evaluate("window.open('about:blank', '_blank')")
        page = pinfo.value
    except Exception:
        page = ctx.new_page()  # 退路：window.open 被拦时
    try:
        page.bring_to_front()
    except Exception:
        pass
    if url:
        human_goto(page, url, wait_until=wait_until)
    return page


@contextmanager
def connect(*, default_timeout_ms: int = 45000):
    """接管运行中的 cloakbrowser，产出持久化 BrowserContext（含登录态）。

    全程持有跨进程 **CDP 锁**（其他 chapi_browser 会话排队），所以这个 with 内可安全地
    `active_page(ctx)` 复用默认页，或 `new_tab(ctx, url)` 多开 1 个标签页（最多 2）同时浏览两页。
    退出 with 只断开 CDP，不关 browser/context。
    """
    from playwright.sync_api import sync_playwright

    with _hold_lock(), sync_playwright() as pw:
        browser = _connect_cdp(pw)
        ctx = _pick_context(browser)
        try:
            ctx.set_default_timeout(default_timeout_ms)
        except Exception:
            pass
        guard_slack_writes(ctx)
        initial = list(ctx.pages)  # tabs that already existed (e.g. the user's own)
        try:
            yield ctx
        finally:
            # 收尾：只关**本会话新开**的标签（保留用户/既有标签，别误关手动打开的页，如 Google 登录页）；
            # 默认页回到空白 → 闲置后实时浏览器自动收起。（绝不 browser.close()/ctx.close()。）
            try:
                for p in list(ctx.pages):
                    if p not in initial:
                        try:
                            p.close()
                        except Exception:
                            pass
                if initial:
                    try:
                        initial[0].goto(_BLANK)
                    except Exception:
                        pass
            except Exception:
                pass
            _unguard(ctx)
            _reset_autoattach(browser)  # 让浏览器恢复"可手动使用"，否则新标签会一直卡在加载


@contextmanager
def open_page(url: str | None = None, *, wait_until: str = "domcontentloaded", timeout_ms: int = 45000):
    """复用 cloakbrowser 的默认页并产出该 Page。**退出时把页面导回空白页**（闲置即空白）。

    传 url 会用 human_goto 拟人打开（仅传**入口页**；详情页用 human_click 点进）。
    需要同时看两个页面时，改用 `connect()` + `new_tab()`。
    """
    from playwright.sync_api import sync_playwright

    with _hold_lock(), sync_playwright() as pw:
        browser = _connect_cdp(pw)
        ctx = _pick_context(browser)
        created = not ctx.pages
        guard_slack_writes(ctx)
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
            _unguard(ctx)
            _reset_autoattach(browser)  # 让浏览器恢复"可手动使用"，否则新标签会一直卡在加载


def open_login(url: str, *, wait_until: str = "domcontentloaded") -> None:
    """给用户手动登录用：打开登录页 → **立即断开自动化并清掉 auto-attach** → 返回。

    关键：需要用户登录时，**不要**用 open_page/connect 长时间占着浏览器等他登录——那样浏览器处于
    自动化控制下，用户开任何新标签都会一直"加载中"。正确流程：
      1) open_login("https://…登录页")
      2) ask_user("请在浏览器里登录，完成后回复我")   ← 期间浏览器完全交给用户，可自由操作
      3) 用户回复后，再 open_page/connect 继续（登录态已存在持久化 profile）。
    """
    from playwright.sync_api import sync_playwright

    with _hold_lock(), sync_playwright() as pw:
        browser = _connect_cdp(pw)
        ctx = _pick_context(browser)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        try:
            page.goto(url, wait_until=wait_until, timeout=45000)
        except Exception:
            pass
        try:
            page.bring_to_front()  # 让用户在桌面上能直接看到登录页
        except Exception:
            pass
        _reset_autoattach(browser)
    # 退出即断开：登录页留在浏览器里，用户可正常操作（不被自动化冻结）。


def fetch_html(url: str, *, wait_until: str = "domcontentloaded", timeout_ms: int = 45000) -> str:
    """便捷函数：拟人打开 url、返回渲染后的 HTML，结束后页面回到空白页。"""
    with open_page(url, wait_until=wait_until, timeout_ms=timeout_ms) as page:
        return page.content()


# ───────────────────────── 接管用户本机 Chrome（已登录账号） ─────────────────────────
#
# 用于"cloakbrowser 里登录不了、只能用用户日常 Chrome 里已有的登录态"的场景。
# 前提：用户在自己的 Chrome 打开 chrome://inspect/#remote-debugging 勾选
# "Allow remote debugging for this browser instance"（Chrome 144+；重启 Chrome 后需重新勾选）。
# Chrome 会把端口写进 User Data/DevToolsActivePort；连接时 Chrome 可能弹窗让用户点"允许"。
#
# 规则（这是用户正在使用的真实浏览器）：
#   - 只读为主：看页面、抓内容；不提交表单、不发消息、不改设置，除非用户明确要求。
#   - 默认在该账号的「chapi 专用窗口」（第二个窗口）**新开一个标签**，结束只关自己开的这个；
#     绝不往用户主窗口里加标签，绝不关闭/导航用户已有的标签。
#   - 用户 Chrome 里有多个账号配置（Profile），按 account 邮箱选对应配置窗口开标签。

CHROME_ACCOUNT = os.environ.get("CHAPI_CHROME_ACCOUNT", "jiaxin.liu@unitpulse.ai")
_CHROME_NOT_ENABLED = (
    "用户的 Chrome 未开启远程调试。请 ask_user：在 Chrome 地址栏打开 chrome://inspect/#remote-debugging，"
    "勾选 \"Allow remote debugging for this browser instance\"，之后连接时如有弹窗点\"允许\"。"
)
_ACCOUNT_PROBE_JS = r"""() => {
  const parts = [document.title || ''];
  for (const el of document.querySelectorAll('[aria-label*="@"], [aria-label*="Google Account"], [aria-label*="Google 帐号"], [aria-label*="Google 账号"]')) {
    parts.push(el.getAttribute('aria-label') || '');
  }
  return parts.join(' | ').toLowerCase();
}"""


_CHROME_NOT_ALLOWED = (
    "本对话没有勾选顶部的「用我的 Chrome」，不能使用用户本机 Chrome（jiaxin.liu@unitpulse.ai）。"
    "请改用 cloakbrowser（open_page/connect）；确实需要用户 Chrome 的登录态时，ask_user 请用户在对话顶部勾选「用我的 Chrome」后再试。"
    "不要绕过此限制。"
)


def _require_user_chrome() -> None:
    """用户 Chrome 默认关闭：只有对话顶部勾选了「用我的 Chrome」才放行（实时向 chapi 服务端查询）。
    失败即拒绝：没有 CHAPI_SESSION_ID（如本功能上线前就已启动的旧运行）也拒绝。"""
    sid = os.environ.get("CHAPI_SESSION_ID")
    if not sid:
        raise PermissionError(_CHROME_NOT_ALLOWED + "（当前运行没有会话 id：请让用户停止本对话后再继续，以便新设置生效。）")
    import json

    try:
        with urllib.request.urlopen(f"{SERVER_URL}/api/user-chrome/{sid}", timeout=5) as r:
            if json.load(r).get("enabled") is True:
                return
    except Exception:  # noqa: BLE001
        pass  # 查不到就按未勾选处理（默认关闭）
    raise PermissionError(_CHROME_NOT_ALLOWED)


def _chrome_user_data_dir() -> str:
    return os.environ.get(
        "CHAPI_CHROME_USER_DATA",
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Google", "Chrome", "User Data"),
    )


def chrome_endpoint() -> str:
    """读 DevToolsActivePort 得到用户 Chrome 的 ws 端点；未开启远程调试则抛错（附操作指引）。"""
    f = os.path.join(_chrome_user_data_dir(), "DevToolsActivePort")
    try:
        with open(f, encoding="utf-8") as fh:
            lines = fh.read().split()
        port, path = lines[0], lines[1]
    except Exception:  # noqa: BLE001
        raise RuntimeError(_CHROME_NOT_ENABLED) from None
    return f"ws://127.0.0.1:{port}{path}"


def _chrome_connect_url() -> str:
    """连接用户 Chrome 用的地址：走 chapi 服务端的中转（一条到 Chrome 的长连接，用户点一次"允许"
    可用 1 小时），而不是每次直连 Chrome（Chrome 对每个新连接都会弹窗要求允许）。"""
    chrome_endpoint()  # 未开启远程调试时在这里给出操作指引
    sid = os.environ.get("CHAPI_SESSION_ID", "")
    token = os.environ.get("CHAPI_USER_CHROME_TOKEN", "")
    if not token:
        raise PermissionError("当前运行没有用户 Chrome 中转口令（chapi 服务端重启前启动的旧运行）。请让用户停止本对话后再继续。")
    base = SERVER_URL.replace("https://", "wss://", 1).replace("http://", "ws://", 1).rstrip("/")
    q = urllib.parse.urlencode({"session": sid, "token": token})
    return f"{base}/cdp/user-chrome?{q}"


def _connect_chrome(pw):
    # 首次（或 1 小时到期后）连接时，用户要在 Chrome 弹窗里点"允许"，给足时间。
    return pw.chromium.connect_over_cdp(_chrome_connect_url(), timeout=120000)


def _target_id(page) -> str | None:
    try:
        s = page.context.new_cdp_session(page)
        tid = s.send("Target.getTargetInfo")["targetInfo"]["targetId"]
        s.detach()
        return tid
    except Exception:  # noqa: BLE001
        return None


def _page_by_target(browser, target_id: str, timeout_s: float = 15.0):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        for ctx in browser.contexts:
            for p in ctx.pages:
                if _target_id(p) == target_id:
                    return p
        time.sleep(0.3)
    raise RuntimeError(f"找不到新开的标签页 {target_id}")


def _chrome_pages_by_context(browser) -> dict[str, list[dict]]:
    """{browserContextId: [{targetId,url,title}]}——每个 Chrome 配置(Profile)一个 context。"""
    s = browser.new_browser_cdp_session()
    out: dict[str, list[dict]] = {}
    for t in s.send("Target.getTargets")["targetInfos"]:
        if t.get("type") == "page":
            out.setdefault(t.get("browserContextId") or "", []).append(t)
    return out


def _chrome_context_for(browser, account: str) -> str:
    """找到登录了 account 的那个 Chrome 配置的 browserContextId。

    先读该配置里已打开的 Google 页面（标题/账号按钮的 aria-label，只读）；都看不出来时，
    在各配置后台开一个 accounts.google.com/ListAccounts 小标签确认，看完立即关掉。
    """
    acct = account.lower()
    groups = _chrome_pages_by_context(browser)
    pw_pages = {(_target_id(p) or ""): p for c in browser.contexts for p in c.pages}
    for ctx_id, targets in groups.items():
        for t in targets:
            if not t["url"].startswith("http"):
                continue
            if acct in (t.get("title") or "").lower():
                return ctx_id
            p = pw_pages.get(t["targetId"])
            if p is None or "google." not in t["url"]:
                continue
            try:
                if acct in p.evaluate(_ACCOUNT_PROBE_JS):
                    return ctx_id
            except Exception:  # noqa: BLE001
                pass
    s = browser.new_browser_cdp_session()
    for ctx_id in groups:
        if not ctx_id:
            continue
        tid = None
        try:
            tid = s.send("Target.createTarget", {
                "url": "https://accounts.google.com/ListAccounts?json=standard&source=ChromiumBrowser",
                "browserContextId": ctx_id, "background": True,
            })["targetId"]
            p = _page_by_target(browser, tid)
            p.wait_for_load_state("domcontentloaded", timeout=15000)
            if acct in p.content().lower():
                return ctx_id
        except Exception:  # noqa: BLE001
            pass
        finally:
            if tid:
                try:
                    s.send("Target.closeTarget", {"targetId": tid})
                except Exception:  # noqa: BLE001
                    pass
    raise RuntimeError(
        f"用户 Chrome 里没找到登录 {account} 的窗口。请 ask_user 打开该账号的 Chrome 配置窗口（至少一个标签）后重试。"
    )


def chrome_tabs(account: str | None = CHROME_ACCOUNT) -> list[dict]:
    """列出用户 Chrome 里（某账号配置下）已打开的标签：[{url,title}]。只读。"""
    from playwright.sync_api import sync_playwright

    _require_user_chrome()
    with _hold_chrome_lock(), sync_playwright() as pw:
        browser = _connect_chrome(pw)
        try:
            groups = _chrome_pages_by_context(browser)
            ids = [_chrome_context_for(browser, account)] if account else list(groups)
            return [{"url": t["url"], "title": t.get("title", "")} for i in ids for t in groups.get(i, [])]
        finally:
            _reset_autoattach(browser)


def _chapi_window_file() -> str:
    return os.path.join(tempfile.gettempdir(), "chapi-user-chrome-window.json")


def _new_tab_in_chapi_window(browser, ctx_id: str, targets: list[dict]):
    """在该账号的「chapi 专用窗口」里开一个新标签，**绝不进用户的主窗口**。

    专用窗口 = 该账号开着多个窗口时，标签最少的那个（用户另开给 chapi 的窗口）；
    只有一个窗口时，后台新建一个窗口。选定后记在临时文件里（按 Chrome 端点，Chrome 重启即失效）。
    新标签用该窗口里某个页面的 window.open 弹出——新标签会落在同一个窗口；
    Target.createTarget 不能指定窗口（会落到用户最近用的主窗口），所以不用它。
    """
    import json

    s = browser.new_browser_cdp_session()
    endpoint = chrome_endpoint()
    by_win: dict[int, list[dict]] = {}
    for t in targets:
        try:
            wid = s.send("Browser.getWindowForTarget", {"targetId": t["targetId"]})["windowId"]
            by_win.setdefault(wid, []).append(t)
        except Exception:  # noqa: BLE001
            pass

    win = None
    try:
        with open(_chapi_window_file(), encoding="utf-8") as fh:
            saved = json.load(fh)
        if saved.get("endpoint") == endpoint and saved.get("context") == ctx_id and saved.get("window") in by_win:
            win = saved["window"]
    except Exception:  # noqa: BLE001
        pass
    if win is None and len(by_win) >= 2:
        win = min(by_win, key=lambda w: len(by_win[w]))

    page = None
    if win is not None:
        openers = [t for t in by_win[win] if t["url"].startswith(("http", "about:", "chrome://newtab", "chrome://new-tab-page"))]
        for t in openers:
            try:
                opener = _page_by_target(browser, t["targetId"], timeout_s=5)
                with opener.context.expect_page(timeout=10000) as pinfo:
                    opener.evaluate("() => { window.open('about:blank', '_blank'); }")
                page = pinfo.value
                break
            except Exception:  # noqa: BLE001
                continue
    if page is None:
        # 只有主窗口（或专用窗口里没有可用页面）→ 后台新建一个窗口给 chapi 用
        params = {"url": _BLANK, "newWindow": True, "background": True}
        if ctx_id:
            params["browserContextId"] = ctx_id
        tid = s.send("Target.createTarget", params)["targetId"]
        page = _page_by_target(browser, tid)
        win = s.send("Browser.getWindowForTarget", {"targetId": tid})["windowId"]
    try:
        with open(_chapi_window_file(), "w", encoding="utf-8") as fh:
            json.dump({"endpoint": endpoint, "context": ctx_id, "window": win}, fh)
    except Exception:  # noqa: BLE001
        pass
    return page


@contextmanager
def _hold_chrome_lock():
    lk = _CdpLock(os.path.join(tempfile.gettempdir(), "chapi-user-chrome.lock"))
    lk.acquire()
    try:
        yield
    finally:
        lk.release()


@contextmanager
def open_chrome_page(url: str | None = None, *, account: str | None = CHROME_ACCOUNT,
                     use_tab: str | None = None, wait_until: str = "domcontentloaded",
                     timeout_ms: int = 45000):
    """在**用户本机 Chrome**（带其已有登录态）里打开页面，产出 Page。

    - 默认：在 account 对应配置的 **chapi 专用窗口**（该账号的第二个窗口；没有就后台新建）里新开一个标签
      打开 url，**不进用户主窗口**；退出时只关这个标签。
    - use_tab="子串"：直接读用户**已打开**、URL 含该子串的标签（不导航、不关闭；传 url 会被忽略）。
    - account=None：不区分账号，用第一个配置。
    用法：
        from chapi_browser import open_chrome_page
        with open_chrome_page("https://mail.google.com/mail/u/0/#inbox") as page:
            print(page.title())
    """
    from playwright.sync_api import sync_playwright

    _require_user_chrome()
    with _hold_chrome_lock(), sync_playwright() as pw:
        browser = _connect_chrome(pw)
        page, created = None, False
        try:
            groups = _chrome_pages_by_context(browser)
            ctx_id = _chrome_context_for(browser, account) if account else next(iter(groups), "")
            if use_tab:
                hit = next((t for t in groups.get(ctx_id, []) if use_tab in t["url"]), None)
                if not hit:
                    raise RuntimeError(f"该账号的 Chrome 窗口里没有 URL 含 {use_tab!r} 的标签")
                page = _page_by_target(browser, hit["targetId"])
            else:
                page, created = _new_tab_in_chapi_window(browser, ctx_id, groups.get(ctx_id, [])), True
            page.set_default_timeout(timeout_ms)
            guard_slack_writes(page)
            if url and created:
                page.goto(url, wait_until=wait_until)
            yield page
        finally:
            if page is not None:
                _unguard(page)
            if created and page is not None:
                try:
                    page.close()
                except Exception:  # noqa: BLE001
                    pass
            _reset_autoattach(browser)  # 断开前清 auto-attach，否则用户新开的标签会卡在加载


# ───────────────────────── 异步版本（同样复用默认页） ─────────────────────────

async def human_pause_async(min_s: float = 0.6, max_s: float = 2.4) -> None:
    await asyncio.sleep(random.uniform(min_s, max_s))


async def human_goto_async(page, url: str, *, wait_until: str = "domcontentloaded", settle: tuple[float, float] = (1.2, 3.0)) -> None:
    await page.goto(url, wait_until=wait_until)
    await human_pause_async(*settle)


@asynccontextmanager
async def open_page_async(url: str | None = None, *, wait_until: str = "domcontentloaded", timeout_ms: int = 45000):
    """open_page() 的异步版本（复用默认页，持有 CDP 锁）。多标签同看请在同一脚本里开。"""
    from playwright.async_api import async_playwright

    _lk = _CdpLock()
    _lk.acquire()
    try:
        async with async_playwright() as pw:
            _ensure_browser_running()
            browser = await pw.chromium.connect_over_cdp(CDP_ENDPOINT, timeout=_CONNECT_TIMEOUT_MS)
            ctxs = browser.contexts
            if not ctxs:
                raise RuntimeError(_NO_CONTEXT_MSG)
            ctx = ctxs[0]
            try:
                await ctx.route(_SLACK_API_RE, _slack_route_async)
            except Exception as e:  # noqa: BLE001
                raise RuntimeError(f"Slack 只读拦截安装失败，已中止：{e}") from e
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
                try:
                    await ctx.unroute_all(behavior="ignoreErrors")
                except Exception:  # noqa: BLE001
                    pass
                await _reset_autoattach_async(browser)
    finally:
        _lk.release()


if __name__ == "__main__":
    # 自检：连接 + 复用默认页 + 打印标题。用法：python chapi_browser.py [url]
    # Google 搜索：python chapi_browser.py google "query" ["query2" ...] [--pages 2] [--json out.json]
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "google":
        import json as _json

        args = sys.argv[2:]
        n_pages, out_path, qs = 2, None, []
        i = 0
        while i < len(args):
            if args[i] == "--pages":
                n_pages = int(args[i + 1]); i += 2
            elif args[i] == "--json":
                out_path = args[i + 1]; i += 2
            else:
                qs.append(args[i]); i += 1
        try:
            res = google_search_many(qs, n_pages)
        except GoogleCaptcha as e:
            print(f"[chapi_browser] CAPTCHA: {e}", flush=True)
            sys.exit(2)
        if out_path:
            with open(out_path, "w", encoding="utf-8") as f:
                _json.dump(res, f, ensure_ascii=False, indent=2)
        for q, rs in res.items():
            print(f"## {q}  ({len(rs)} results, {max([r['page'] for r in rs] or [0])} pages)")
            for r in rs:
                print(f"{r['rank']:>2}. [p{r['page']}] {r['title']}\n    {r['url']}\n    {r['date'] or ''} {r['snippet'][:200]}")
        sys.exit(0)

    target = sys.argv[1] if len(sys.argv) > 1 else "https://example.com"
    print(f"[chapi_browser] CDP={CDP_ENDPOINT} -> {target}", flush=True)
    try:
        with open_page(target) as page:
            page.wait_for_load_state("load")
            print(f"[chapi_browser] OK title={page.title()!r} url={page.url}", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"[chapi_browser] FAILED: {e}", flush=True)
        sys.exit(1)
