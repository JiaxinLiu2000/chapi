"""
Open a headful cloakbrowser using a persistent profile so the user can log into
accounts manually. Cookies/localStorage persist in the profile dir and are reused
by `cloakserve` (and therefore the agent) on later runs.

Invoked by the server's supervisor via:
    uvx --from cloakbrowser python tools/browser/login.py <profile_dir>

cloakbrowser is a drop-in Playwright replacement, so its sync API mirrors
Playwright's. We probe for the available launch function to be resilient across
versions.
"""
import sys
import time

profile = sys.argv[1] if len(sys.argv) > 1 else "./.browser-profile"
print(f"[chapi-login] profile dir: {profile}", flush=True)

try:
    import cloakbrowser as cb
except Exception as e:  # noqa: BLE001
    print(f"[chapi-login] cannot import cloakbrowser: {e}", flush=True)
    sys.exit(1)


def open_context():
    if hasattr(cb, "launch_persistent_context"):
        return cb.launch_persistent_context(profile, headless=False)
    if hasattr(cb, "launch"):
        try:
            return cb.launch(headless=False, user_data_dir=profile)
        except TypeError:
            return cb.launch(headless=False)
    raise RuntimeError("no known cloakbrowser launch API (launch_persistent_context/launch)")


ctx = open_context()

page = None
try:
    page = ctx.new_page()
except Exception:  # noqa: BLE001
    pages = getattr(ctx, "pages", None)
    if pages:
        page = pages[0]

if page is not None:
    try:
        page.goto("https://accounts.google.com")
    except Exception as e:  # noqa: BLE001
        print(f"[chapi-login] initial navigation failed: {e}", flush=True)

print("[chapi-login] Login window open. Sign in, then close the browser to save.", flush=True)

# Stay alive until all pages are closed (user closed the window) or 15 minutes.
deadline = time.time() + 900
while time.time() < deadline:
    time.sleep(1)
    try:
        pages = getattr(ctx, "pages", None)
        if pages is not None and len(pages) == 0:
            break
    except Exception:  # noqa: BLE001
        break

try:
    ctx.close()
except Exception:  # noqa: BLE001
    pass
print("[chapi-login] done — logins saved to profile.", flush=True)
