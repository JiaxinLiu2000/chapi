"""Authorize a read-only Gmail mailbox for chapi (GMAIL_READONLY_EMAILS).

Usage:
  uv run --with google-auth-oauthlib python scripts/gmail-readonly-auth.py raymond.fernandez@unitpulse.ai
  uv run --with google-auth-oauthlib python scripts/gmail-readonly-auth.py raymond.fernandez@unitpulse.ai --finish "<redirected URL>"

Opens the Google consent page for that mailbox asking only gmail.readonly (+ identity)
and writes the token where chapi's gmail_ro_<name> MCP reads it:
~/.google_workspace_mcp/gmail-readonly/<email>/<email>.json

The OAuth client is a "web" client whose ONLY registered redirect is
http://localhost:8000/oauth2callback — the same port chapi's workspace-mcp processes
bind for their own auth flows / attachment links. If one of them is already holding
port 8000, the browser's redirect lands on workspace-mcp, which rejects our state with
"Invalid or expired OAuth state parameter". So:
  * port 8000 free  → we bind it exclusively (IPv4 + IPv6) and catch the callback;
  * port 8000 taken → paste mode: after consenting, the browser shows that error page,
    but its address bar still holds our unused ?code=…&state=…. Paste that URL (stdin
    when interactive, or re-run with --finish "<url>").

The OAuth client id/secret are taken from the existing drafts-account credentials
(same OAuth app). While the app is in "testing", the mailbox must be listed as a
test user and the refresh token expires after ~7 days — just re-run this script.
"""
import http.server
import json
import os
import socket
import sys
import threading
import time
import urllib.parse
import webbrowser
from pathlib import Path

from google_auth_oauthlib.flow import Flow

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "openid",
]
PORT = 8000
REDIRECT = f"http://localhost:{PORT}/oauth2callback"
# Google's granular consent lets the user untick Gmail; don't crash on the narrower
# scope set — the explicit gmail.readonly check below gives a clear message instead.
os.environ.setdefault("OAUTHLIB_RELAX_TOKEN_SCOPE", "1")
BASE = Path.home() / ".google_workspace_mcp"
PENDING_DIR = BASE / "gmail-readonly" / ".pending"
PENDING_TTL_S = 15 * 60  # Google auth codes are short-lived anyway


def client_from_existing() -> tuple[str, str]:
    cid = os.environ.get("GOOGLE_OAUTH_CLIENT_ID")
    secret = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET")
    if cid and secret:
        return cid, secret
    for f in sorted((BASE / "gmail-drafts").glob("*@*.json")):
        d = json.loads(f.read_text())
        if d.get("client_id") and d.get("client_secret"):
            return d["client_id"], d["client_secret"]
    sys.exit("No OAuth client found: set GOOGLE_OAUTH_CLIENT_ID/SECRET or authorize the drafts account first.")


def make_flow(cid: str, secret: str, **kw) -> Flow:
    return Flow.from_client_config(
        {"web": {"client_id": cid, "client_secret": secret,
                 "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                 "token_uri": "https://oauth2.googleapis.com/token"}},
        scopes=SCOPES, redirect_uri=REDIRECT, **kw,
    )


class ExclusiveServer(http.server.HTTPServer):
    # HTTPServer defaults to SO_REUSEADDR, which on Windows lets us bind a port another
    # process is already listening on — the browser then hits *that* process. Refuse.
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):  # Windows
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class ExclusiveServer6(ExclusiveServer):
    address_family = socket.AF_INET6


def bind_callback(handler) -> list[http.server.HTTPServer] | None:
    """Bind localhost:PORT on 127.0.0.1 AND ::1 (browsers may resolve `localhost` to
    either). None if either is already taken by someone else."""
    servers: list[http.server.HTTPServer] = []
    for cls, host in ((ExclusiveServer, "127.0.0.1"), (ExclusiveServer6, "::1")):
        try:
            servers.append(cls((host, PORT), handler))
        except OSError as e:
            if cls is ExclusiveServer6 and not socket.has_ipv6:
                continue
            if isinstance(e, PermissionError) or getattr(e, "winerror", None) in (10013, 10048) or e.errno in (98, 48, 10048, 13):
                for s in servers:
                    s.server_close()
                return None
            if cls is ExclusiveServer6:  # IPv6 unavailable on this box — IPv4 is enough
                continue
            raise
    return servers


def save_token(email: str, cid: str, secret: str, creds) -> None:
    granted = set(creds.scopes or [])
    if "https://www.googleapis.com/auth/gmail.readonly" not in granted:
        sys.exit(f"gmail.readonly was not granted — tick the Gmail checkbox on the consent page and re-run (got {sorted(granted)})")
    out_dir = BASE / "gmail-readonly" / email
    out_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    out = out_dir / f"{email}.json"
    # Owner-only (POSIX); on Windows the user-profile ACL already restricts it.
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(json.dumps({
            "token": creds.token,
            "refresh_token": creds.refresh_token,
            "token_uri": creds.token_uri,
            "client_id": cid,
            "client_secret": secret,
            "scopes": sorted(granted),
            "expiry": creds.expiry.isoformat() if creds.expiry else None,
        }))
    os.chmod(out, 0o600)
    print(f"Saved {out}  scopes={sorted(granted)}")


def parse_redirect(url: str) -> dict[str, str]:
    q = urllib.parse.parse_qs(urllib.parse.urlparse(url.strip().strip('"').strip("'")).query)
    return {k: v[0] for k, v in q.items()}


def pending_path(email: str) -> Path:
    return PENDING_DIR / f"{email}.json"


def finish(email: str, cid: str, secret: str, redirected_url: str) -> None:
    p = pending_path(email)
    if not p.exists():
        sys.exit(f"No pending authorization for {email} — run without --finish first.")
    pending = json.loads(p.read_text())
    if time.time() - pending["created"] > PENDING_TTL_S:
        p.unlink(missing_ok=True)
        sys.exit("That authorization attempt expired — run the script again without --finish.")
    got = parse_redirect(redirected_url)
    if got.get("error"):
        sys.exit(f"Authorization failed: {got['error']}")
    if got.get("state") != pending["state"] or "code" not in got:
        sys.exit("That URL doesn't belong to the latest authorization attempt (state mismatch or no code). "
                 "Copy the FULL address-bar URL from the page you landed on after consenting.")
    flow = make_flow(cid, secret, state=pending["state"], code_verifier=pending["code_verifier"])
    flow.fetch_token(code=got["code"])
    p.unlink(missing_ok=True)
    save_token(email, cid, secret, flow.credentials)


def main() -> None:
    args = sys.argv[1:]
    finish_url = None
    if "--finish" in args:
        i = args.index("--finish")
        if i + 1 >= len(args):
            sys.exit(__doc__)
        finish_url = args[i + 1]
        del args[i:i + 2]
    if len(args) != 1 or "@" not in args[0]:
        sys.exit(__doc__)
    email = args[0].strip().lower()
    cid, secret = client_from_existing()

    if finish_url is not None:
        finish(email, cid, secret, finish_url)
        return

    flow = make_flow(cid, secret)
    url, state = flow.authorization_url(access_type="offline", prompt="consent", login_hint=email)

    result: dict[str, str] = {}
    done = threading.Event()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            if not self.path.startswith("/oauth2callback"):
                self.send_response(404); self.end_headers(); return
            result.update(parse_redirect(self.path))
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write("授权完成，可以关闭此页面。".encode())
            done.set()

        def log_message(self, *a):
            pass

    servers = bind_callback(Handler)
    if servers is None:
        # Port 8000 is held by another process (normally chapi's own workspace-mcp).
        PENDING_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
        pending_path(email).write_text(json.dumps(
            {"state": state, "code_verifier": flow.code_verifier, "created": time.time()}))
        print(
            f"Port {PORT} is in use by another program (usually chapi's workspace-mcp), so the "
            "browser redirect can't be caught automatically.\n"
            f"1) Open this URL and sign in as {email}:\n{url}\n"
            "2) After you allow access the browser will show an error page "
            "(\"Invalid or expired OAuth state parameter\") — that's expected.\n"
            "3) Copy the FULL URL from that page's address bar "
            "(starts with http://localhost:8000/oauth2callback?...).",
            flush=True,
        )
        webbrowser.open(url)
        pasted = ""
        if sys.stdin and sys.stdin.isatty():
            try:
                pasted = input("Paste it here and press Enter: ").strip()
            except EOFError:  # "tty" that can't actually be read (agent / IDE runners)
                pasted = ""
        if pasted:
            finish(email, cid, secret, pasted)
            return
        print(f'\nThen run:\n  uv run --with google-auth-oauthlib python scripts/gmail-readonly-auth.py {email} --finish "<that URL>"')
        sys.exit(2)

    for s in servers:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    print(f"Open this URL and sign in as {email}:\n{url}\n", flush=True)
    webbrowser.open(url)
    done.wait(timeout=600)
    for s in servers:
        s.shutdown()
        s.server_close()

    if result.get("state") != state or "code" not in result:
        sys.exit(f"Authorization failed: {result.get('error', 'no code / state mismatch / timeout')}")
    flow.fetch_token(code=result["code"])
    save_token(email, cid, secret, flow.credentials)


if __name__ == "__main__":
    main()
