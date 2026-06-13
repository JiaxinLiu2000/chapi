"""
Launch the single persistent cloakbrowser instance with a CDP debugging port so
the agent (scripts over CDP), the live-view screencast, and manual logins all
share ONE stealth browser + ONE persistent profile.

Invoked by the server supervisor:
    uvx --from cloakbrowser python tools/browser/serve.py <profile_dir> <cdp_port> <headless>

cloakbrowser exposes no `cloakserve` command (the CLI only manages the binary);
it's a Playwright-style library, so we pass --remote-debugging-port via args.

IMPORTANT — crash-restore doom loop:
cloakbrowser is a fingerprint-spoofing Chromium with C++ WebGL patches. On a very
heavy WebGL/canvas site (e.g. apartments.com behind PerimeterX) the GPU process can
crash. Chromium then records exit_type="Crashed" and on the NEXT launch auto-restores
that same heavy tab (+ shows the restore bubble) → it crashes again → the profile is
permanently wedged ("even manually opening any page crashes"). So before every launch
we HEAL the profile: clear the crashed flag, drop session/tab restore, and (only if it
had crashed) clear the GPU shader caches. Cookies/logins live in other files and are
left intact.
"""
import json
import os
import shutil
import sys
import time

profile = sys.argv[1] if len(sys.argv) > 1 else "./.browser-profile"
port = sys.argv[2] if len(sys.argv) > 2 else "9222"
headless = len(sys.argv) > 3 and str(sys.argv[3]).lower() == "true"
print(f"[cloakserve] starting: profile={profile} cdp=127.0.0.1:{port} headless={headless}", flush=True)


def heal_profile(profile_dir: str) -> None:
    """Break the crash-restore doom loop. Safe + idempotent; never touches cookies/logins."""
    default = os.path.join(profile_dir, "Default")
    prefs_path = os.path.join(default, "Preferences")
    had_crashed = False
    # 1) Clear the "Crashed" exit flag so Chromium won't try to restore the crashed tabs.
    try:
        with open(prefs_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        prof = data.get("profile")
        if isinstance(prof, dict):
            if prof.get("exit_type") not in (None, "Normal"):
                had_crashed = True
            prof["exit_type"] = "Normal"
            prof["exited_cleanly"] = True
            with open(prefs_path, "w", encoding="utf-8") as f:
                json.dump(data, f)
            print(f"[cloakserve] healed profile (was_crashed={had_crashed})", flush=True)
    except FileNotFoundError:
        pass  # fresh profile
    except Exception as e:  # noqa: BLE001
        print(f"[cloakserve] prefs heal skipped: {e}", flush=True)
    # 2) Drop session/tab restore so a heavy crashed tab is never auto-reopened.
    for name in ("Current Session", "Current Tabs", "Last Session", "Last Tabs"):
        try:
            os.remove(os.path.join(default, name))
        except FileNotFoundError:
            pass
        except Exception:
            pass
    try:
        shutil.rmtree(os.path.join(default, "Sessions"), ignore_errors=True)
    except Exception:
        pass
    # 3) If it had crashed, a corrupted GPU shader cache can crash the next launch too — clear it.
    if had_crashed:
        for cache in ("GrShaderCache", "ShaderCache", "GraphiteDawnCache"):
            shutil.rmtree(os.path.join(profile_dir, cache), ignore_errors=True)
        print("[cloakserve] cleared GPU shader caches after crash", flush=True)


heal_profile(profile)

try:
    from cloakbrowser import launch_persistent_context
except Exception as e:  # noqa: BLE001
    print(f"[cloakserve] import failed: {e}", flush=True)
    sys.exit(1)

# Base args: CDP endpoint + don't nag/restore after a crash. Extra args (e.g.
# "--disable-gpu" as a last-resort stability knob, or "--fingerprint-noise=false")
# can be appended via CLOAKBROWSER_EXTRA_ARGS without code changes.
args = [
    f"--remote-debugging-port={port}",
    "--remote-debugging-address=127.0.0.1",
    "--hide-crash-restore-bubble",
    "--disable-session-crashed-bubble",
    "--no-first-run",
]
extra = os.environ.get("CLOAKBROWSER_EXTRA_ARGS", "").split()
if extra:
    args.extend(extra)
    print(f"[cloakserve] extra args: {extra}", flush=True)

try:
    ctx = launch_persistent_context(profile, headless=headless, args=args)
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
