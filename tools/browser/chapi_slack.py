"""
chapi_slack — **只读** Slack：借用 cloakbrowser 里已登录的 Slack 网页会话读取频道/私信记录。

⚠️ Slack 只读（硬性规定）：
  - 只能用本模块读取。本模块只放行白名单里的读取接口（READ_METHODS），其他一律 PermissionError。
  - chapi_browser 每次连接浏览器都会拦截 Slack 写操作（发消息/编辑/删除/表情/上传/标为已读/
    加入或离开频道……），所以也**不要**在 Slack 网页界面里点按钮、输入框打字——会被拦截，也违反规定。
  - 不要自己从浏览器取令牌/cookie 另写请求，不要绕过白名单。
  - 读到的聊天内容只用于本任务，不要写进 AI Wiki。

登录（cloakbrowser 里没登录 Slack 时）：
    uv run --with playwright python chapi_slack.py login     # 打开 Slack 登录页后立即放手
    → ask_user 请用户在实时浏览器里登录 UnitPulse 的 Slack，完成后回复
    uv run --with playwright python chapi_slack.py check     # 确认已登录（打印用户/工作区）

导出一段时间内的记录（频道 + 私信，按 PT 日期，含消息串回复）：
    uv run --with playwright --with tzdata python chapi_slack.py export --since 2026-11-07 --until 2026-11-13 --out slack_week
    → slack_week.md（按会话分组、可直接读）+ slack_week.json（结构化）
    选项：--types public_channel,private_channel,mpim,im（默认全部）  --team <工作区名/域名子串>

搜索（Slack 自带搜索语法，如 "from:@raymond after:2026-11-06"、"in:#sales Copperline"）：
    uv run --with playwright python chapi_slack.py search "Copperline after:2026-11-06" --count 50

在脚本里用：
    from chapi_slack import slack_reader
    with slack_reader() as s:
        me = s.call("auth.test")
        convs = s.conversations()
        msgs = s.history(convs[0]["id"], oldest=..., latest=...)
"""
from __future__ import annotations

import json
import random
import re
import sys
import time
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone, tzinfo

from chapi_browser import active_page, connect, is_slack_write, open_login

# 只放行这些读取接口（Slack Web API 方法名）。需要别的只读接口时改这里，绝不放写接口。
READ_METHODS = frozenset({
    "auth.test",
    "team.info",
    "users.list",
    "users.info",
    "users.conversations",
    "usergroups.list",
    "bots.info",
    "conversations.list",
    "conversations.info",
    "conversations.history",
    "conversations.replies",
    "conversations.members",
    "files.info",
    "search.messages",
})

SIGNIN_URL = "https://slack.com/signin"
_LOCAL_CONFIG_JS = r"""() => {
  try { return localStorage.getItem('localConfig_v2'); } catch (e) { return null; }
}"""
# Same-origin POST to /api/<method>; the token goes in the form body, the `d` cookie rides along.
_FETCH_JS = r"""async ({method, params}) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body.append(k, String(v));
  const r = await fetch('/api/' + method, {method: 'POST', body, credentials: 'include'});
  let data = null;
  try { data = await r.json(); } catch (e) { data = {ok: false, error: 'non_json_response'}; }
  return {status: r.status, retryAfter: r.headers.get('retry-after'), data};
}"""


class SlackNotLoggedIn(RuntimeError):
    pass


# ───────────────────────── 时间（PT） ─────────────────────────

def _pt() -> tzinfo:
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo("America/Los_Angeles")
    except Exception:  # Windows 没装 tzdata：按美国夏令时规则自己算
        return _USPacific()


class _USPacific(tzinfo):
    """America/Los_Angeles fallback: DST from 2nd Sunday of March 02:00 to 1st Sunday of Nov 02:00."""

    @staticmethod
    def _nth_sunday(y: int, m: int, n: int) -> datetime:
        d = datetime(y, m, 1)
        d += timedelta(days=(6 - d.weekday()) % 7)
        return d + timedelta(weeks=n - 1)

    def dst(self, dt):
        if dt is None:
            return timedelta(0)
        naive = dt.replace(tzinfo=None)
        start = self._nth_sunday(dt.year, 3, 2).replace(hour=2)
        end = self._nth_sunday(dt.year, 11, 1).replace(hour=2)
        return timedelta(hours=1) if start <= naive < end else timedelta(0)

    def utcoffset(self, dt):
        return timedelta(hours=-8) + self.dst(dt)

    def tzname(self, dt):
        return "PDT" if self.dst(dt) else "PST"


PT = _pt()


def pt_day_range(since: str, until: str) -> tuple[float, float]:
    """'2026-11-07','2026-11-13' (PT, inclusive) → (oldest, latest) epoch seconds."""
    a = datetime.combine(date.fromisoformat(since), datetime.min.time(), tzinfo=PT)
    b = datetime.combine(date.fromisoformat(until) + timedelta(days=1), datetime.min.time(), tzinfo=PT)
    return a.timestamp(), b.timestamp()


def fmt_ts(ts: str | float) -> str:
    return datetime.fromtimestamp(float(ts), tz=timezone.utc).astimezone(PT).strftime("%Y-%m-%d %H:%M")


# ───────────────────────── 读取器 ─────────────────────────

class SlackReader:
    def __init__(self, page, team: dict):
        self._page = page
        self._token = team["token"]
        self.team = {k: team.get(k) for k in ("id", "name", "domain", "url")}
        self._users: dict[str, str] | None = None

    def call(self, method: str, **params) -> dict:
        """调用一个**只读** Slack Web API 方法；非白名单方法一律拒绝。自动处理限流重试。"""
        if method not in READ_METHODS or is_slack_write(method):
            raise PermissionError(f"Slack 只读：不允许调用 {method}（只放行 {sorted(READ_METHODS)}）")
        for attempt in range(6):
            res = self._page.evaluate(_FETCH_JS, {"method": method, "params": {**params, "token": self._token}})
            data = res.get("data") or {}
            if res.get("status") == 429 or data.get("error") == "ratelimited":
                wait = float(res.get("retryAfter") or 3) + random.uniform(0.2, 1.0)
                time.sleep(wait)
                continue
            if not data.get("ok"):
                if data.get("error") in ("invalid_auth", "not_authed", "token_revoked", "account_inactive"):
                    raise SlackNotLoggedIn(f"Slack 会话已失效（{data.get('error')}），需要重新登录：python chapi_slack.py login")
                raise RuntimeError(f"Slack {method} 失败：{data.get('error')} {data.get('needed') or ''}".strip())
            return data
        raise RuntimeError(f"Slack {method} 连续被限流，稍后再试")

    def paginate(self, method: str, key: str, *, max_pages: int = 200, pause: tuple[float, float] = (0.2, 0.6), **params) -> list:
        out, cursor = [], None
        for _ in range(max_pages):
            data = self.call(method, **params, **({"cursor": cursor} if cursor else {}))
            out.extend(data.get(key) or [])
            cursor = (data.get("response_metadata") or {}).get("next_cursor")
            if not cursor:
                break
            time.sleep(random.uniform(*pause))
        return out

    # ── 便捷方法 ──
    def users(self) -> dict[str, str]:
        """user id → 显示名（含 bot）。"""
        if self._users is None:
            self._users = {}
            for u in self.paginate("users.list", "members", limit=200):
                p = u.get("profile") or {}
                self._users[u["id"]] = p.get("display_name") or p.get("real_name") or u.get("real_name") or u.get("name") or u["id"]
        return self._users

    def user_name(self, uid: str | None) -> str:
        if not uid:
            return "?"
        return self.users().get(uid, uid)

    def conversations(self, types: str = "public_channel,private_channel,mpim,im") -> list[dict]:
        """我所在的频道 / 私有频道 / 群私信 / 私信（不含已归档）。每项加 `label` 便于阅读。"""
        convs = self.paginate("users.conversations", "channels", types=types, exclude_archived="true", limit=200)
        for c in convs:
            c["label"] = self.label(c)
        return convs

    def label(self, c: dict) -> str:
        if c.get("is_im"):
            return f"私信 · {self.user_name(c.get('user'))}"
        if c.get("is_mpim"):
            name = re.sub(r"^mpdm-|-\d+$", "", c.get("name") or "")
            return f"群私信 · {', '.join(n for n in name.split('--') if n)}"
        return f"#{c.get('name')}" + ("（私有）" if c.get("is_private") else "")

    def history(self, channel: str, *, oldest: float, latest: float, with_replies: bool = True) -> list[dict]:
        """时间窗内的消息（旧→新）。with_replies 时把消息串回复放进 `replies`。"""
        msgs = self.paginate("conversations.history", "messages", channel=channel,
                             oldest=f"{oldest:.6f}", latest=f"{latest:.6f}", inclusive="true", limit=200)
        msgs.sort(key=lambda m: float(m["ts"]))
        if with_replies:
            for m in msgs:
                if m.get("reply_count") and m.get("thread_ts") == m.get("ts"):
                    reps = self.paginate("conversations.replies", "messages", channel=channel, ts=m["ts"], limit=200)
                    m["replies"] = [r for r in reps if r.get("ts") != m["ts"]]
                    time.sleep(random.uniform(0.2, 0.6))
        return msgs

    def search(self, query: str, count: int = 50) -> list[dict]:
        data = self.call("search.messages", query=query, count=min(count, 100), sort="timestamp", sort_dir="desc")
        return ((data.get("messages") or {}).get("matches")) or []

    # ── 文本整理 ──
    def clean_text(self, m: dict) -> str:
        text = m.get("text") or ""
        text = re.sub(r"<@([UW][A-Z0-9]+)(?:\|[^>]*)?>", lambda x: "@" + self.user_name(x.group(1)), text)
        text = re.sub(r"<#[CG][A-Z0-9]+\|([^>]*)>", r"#\1", text)
        text = re.sub(r"<!(here|channel|everyone)[^>]*>", r"@\1", text)
        text = re.sub(r"<!subteam\^[A-Z0-9]+\|([^>]*)>", r"\1", text)
        text = re.sub(r"<(https?://[^|>]+)\|([^>]+)>", r"\2 (\1)", text)
        text = re.sub(r"<(https?://[^>]+)>", r"\1", text)
        text = text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
        extras = [f"[附件: {f.get('name') or f.get('title')}]" for f in m.get("files") or []]
        extras += [f"[{a.get('fallback') or a.get('title') or a.get('text') or ''}]".strip() for a in m.get("attachments") or []]
        return " ".join([text, *[e for e in extras if e != "[]"]]).strip()

    def author(self, m: dict) -> str:
        if m.get("user"):
            return self.user_name(m["user"])
        return m.get("username") or (m.get("bot_profile") or {}).get("name") or m.get("bot_id") or "?"


_SKIP_SUBTYPES = {"channel_join", "channel_leave", "group_join", "group_leave", "channel_topic",
                  "channel_purpose", "bot_add", "bot_remove", "pinned_item", "unpinned_item"}


def _pick_team(cfg: dict, team: str | None) -> dict:
    teams = cfg.get("teams") or {}
    if not teams:
        raise SlackNotLoggedIn("cloakbrowser 里没有登录 Slack。先运行 python chapi_slack.py login，再 ask_user 请用户登录。")
    if team:
        t = team.lower()
        hits = [v for v in teams.values() if t in f"{v.get('id')} {v.get('name')} {v.get('domain')} {v.get('url')}".lower()]
        if not hits:
            names = ", ".join(f"{v.get('name')}({v.get('domain')})" for v in teams.values())
            raise RuntimeError(f"没找到工作区 {team!r}；已登录的有：{names}")
        return hits[0]
    return teams.get(cfg.get("lastActiveTeamId")) or next(iter(teams.values()))


@contextmanager
def slack_reader(team: str | None = None):
    """接管 cloakbrowser（持有 CDP 锁），产出 SlackReader。退出后浏览器回到空白页。"""
    with connect() as ctx:
        page = active_page(ctx)
        page.goto("https://app.slack.com/robots.txt", wait_until="domcontentloaded")
        raw = page.evaluate(_LOCAL_CONFIG_JS)
        cfg = json.loads(raw) if raw else {}
        t = _pick_team(cfg, team)
        if not t.get("token") or not t.get("url"):
            raise SlackNotLoggedIn("Slack 登录信息不完整，请重新登录：python chapi_slack.py login")
        # Same-origin with the workspace so /api/ calls carry the session cookie without CORS.
        page.goto(t["url"].rstrip("/") + "/robots.txt", wait_until="domcontentloaded")
        yield SlackReader(page, t)


def export(since: str, until: str, out: str = "slack_export", *, types: str = "public_channel,private_channel,mpim,im",
           team: str | None = None) -> dict:
    """导出 [since, until]（PT，含两端）内所有我所在会话的消息 → <out>.md + <out>.json。返回汇总。"""
    oldest, latest = pt_day_range(since, until)
    result = {"team": None, "since": since, "until": until, "timezone": "America/Los_Angeles", "conversations": []}
    with slack_reader(team) as s:
        result["team"] = s.team
        me = s.call("auth.test")
        result["me"] = {"user_id": me.get("user_id"), "user": s.user_name(me.get("user_id"))}
        convs = s.conversations(types)
        print(f"[chapi_slack] {s.team.get('name')}：{len(convs)} 个会话，扫描 {since} ~ {until} (PT)…", flush=True)
        for i, c in enumerate(convs, 1):
            if i % 20 == 0:
                print(f"[chapi_slack]   已扫 {i}/{len(convs)}", flush=True)
            try:
                msgs = s.history(c["id"], oldest=oldest, latest=latest)
            except RuntimeError as e:
                print(f"[chapi_slack]   跳过 {c['label']}：{e}", flush=True)
                continue
            msgs = [m for m in msgs if m.get("subtype") not in _SKIP_SUBTYPES]
            if not msgs:
                continue

            def row(m):
                return {"ts": m["ts"], "time_pt": fmt_ts(m["ts"]), "author": s.author(m), "text": s.clean_text(m)}

            result["conversations"].append({
                "id": c["id"], "label": c["label"],
                "type": "im" if c.get("is_im") else "mpim" if c.get("is_mpim") else "private_channel" if c.get("is_private") else "public_channel",
                "messages": [{**row(m), "replies": [row(r) for r in m.get("replies") or []
                                                     if r.get("subtype") not in _SKIP_SUBTYPES]} for m in msgs],
            })
            time.sleep(random.uniform(0.2, 0.6))

    n_msgs = sum(len(c["messages"]) + sum(len(m["replies"]) for m in c["messages"]) for c in result["conversations"])
    with open(out + ".json", "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    lines = [f"# Slack {result['team'].get('name')} · {since} ~ {until} (PT)", "",
             f"{len(result['conversations'])} 个有消息的会话，共 {n_msgs} 条（含消息串回复）。", ""]
    for c in result["conversations"]:
        lines += [f"## {c['label']}", ""]
        for m in c["messages"]:
            lines.append(f"- {m['time_pt']} **{m['author']}**：{m['text']}")
            for r in m["replies"]:
                lines.append(f"    - ↳ {r['time_pt']} **{r['author']}**：{r['text']}")
        lines.append("")
    with open(out + ".md", "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    summary = {"conversations": len(result["conversations"]), "messages": n_msgs, "files": [out + ".md", out + ".json"]}
    print(f"[chapi_slack] 完成：{summary}", flush=True)
    return summary


def _arg(args: list[str], name: str, default=None):
    if name in args:
        i = args.index(name)
        return args[i + 1]
    return default


if __name__ == "__main__":
    args = sys.argv[1:]
    cmd = args[0] if args else "check"
    team = _arg(args, "--team")
    try:
        if cmd == "login":
            open_login(SIGNIN_URL)
            print("[chapi_slack] 已在 cloakbrowser 打开 Slack 登录页。请 ask_user 让用户登录 UnitPulse 的 Slack，完成后运行 check。")
        elif cmd == "check":
            with slack_reader(team) as s:
                me = s.call("auth.test")
                print(f"[chapi_slack] OK 已登录：{me.get('user')} @ {me.get('team')} ({me.get('url')})")
        elif cmd == "export":
            today = datetime.now(PT).date()
            since = _arg(args, "--since", (today - timedelta(days=6)).isoformat())
            until = _arg(args, "--until", today.isoformat())
            export(since, until, _arg(args, "--out", "slack_export"),
                   types=_arg(args, "--types", "public_channel,private_channel,mpim,im"), team=team)
        elif cmd == "search":
            q = args[1]
            with slack_reader(team) as s:
                for m in s.search(q, int(_arg(args, "--count", 50))):
                    ch = (m.get("channel") or {}).get("name") or "?"
                    print(f"- {fmt_ts(m['ts'])} [{ch}] {m.get('username') or s.user_name(m.get('user'))}：{s.clean_text(m)}")
        else:
            print(__doc__)
            sys.exit(2)
    except SlackNotLoggedIn as e:
        print(f"[chapi_slack] NOT_LOGGED_IN: {e}", flush=True)
        sys.exit(3)
