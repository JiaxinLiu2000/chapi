"""
Launch the single persistent cloakbrowser instance with a CDP debugging port so
the agent (Playwright MCP), the live-view screencast, and manual logins all share
ONE stealth browser + ONE persistent profile.

Invoked by the server supervisor:
    uvx --from cloakbrowser python tools/browser/serve.py <profile_dir> <cdp_port>

cloakbrowser exposes no `cloakserve` command (the CLI only manages the binary);
it's a Playwright-style library, so we pass --remote-debugging-port via args.
"""
import sys
import time

profile = sys.argv[1] if len(sys.argv) > 1 else "./.browser-profile"
port = sys.argv[2] if len(sys.argv) > 2 else "9222"
headless = len(sys.argv) > 3 and str(sys.argv[3]).lower() == "true"
print(f"[cloakserve] starting: profile={profile} cdp=127.0.0.1:{port} headless={headless}", flush=True)

try:
    from cloakbrowser import launch_persistent_context
except Exception as e:  # noqa: BLE001
    print(f"[cloakserve] import failed: {e}", flush=True)
    sys.exit(1)

try:
    ctx = launch_persistent_context(
        profile,
        headless=headless,
        args=[
            f"--remote-debugging-port={port}",
            "--remote-debugging-address=127.0.0.1",
        ],
    )
except Exception as e:  # noqa: BLE001
    print(f"[cloakserve] launch failed: {e}", flush=True)
    sys.exit(1)

# Open a blank start page so the window is visible/usable.
try:
    if not getattr(ctx, "pages", None):
        ctx.new_page()
except Exception:  # noqa: BLE001
    pass

print(f"[cloakserve] ready: CDP on 127.0.0.1:{port}", flush=True)

# Stay alive until the process is killed by the supervisor.
try:
    while True:
        time.sleep(3600)
except KeyboardInterrupt:
    pass
finally:
    try:
        ctx.close()
    except Exception:  # noqa: BLE001
        pass
    print("[cloakserve] stopped", flush=True)
