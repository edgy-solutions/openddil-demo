"""
Playwright plumbing for the Hero Scenario v3 UI smoke tests (29-34).

The UI smoke tests drive a real headless browser against the running
frontend (http://127.0.0.1:3017) and assert that:
  - the three role views (maintainer / regional / HQ) render real pipeline
    data from the ElectricSQL shapes,
  - the DDIL sever/restore staleness banner fires against the *real*
    toxiproxy hq-link mechanic (not a UI simulation), and
  - every DEMO_MOCK component self-identifies with its banner (ADR-0017).

Playwright + a Chromium binary are an OPTIONAL dev dependency. If either is
missing — or the frontend is not reachable — the helpers raise
`UiUnavailable`, and the test SKIPs rather than FAILs. This is the same
graceful-degradation pattern the infra-dependent tests use, and it keeps
`run_all.py` green on a machine without a browser toolchain. To run the UI
tests for real:

    pip install playwright
    playwright install chromium
"""
from __future__ import annotations

import contextlib
import json
import urllib.error
import urllib.request
from typing import Callable, Iterator

# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
FRONTEND_URL  = "http://127.0.0.1:3017"
# toxiproxy's admin API — published to the host as 8475:8475 in the demo
# compose. The frontend reaches the same API via its nginx /proxies/ path;
# the tests hit it directly so a UI test failure can't be confused with an
# nginx-proxy failure.
TOXIPROXY_API = "http://127.0.0.1:8475"
HQ_LINK_PROXY = "hq-link"

DEFAULT_TIMEOUT_MS = 15_000


class UiUnavailable(Exception):
    """Playwright, its browser binary, or the frontend is not available —
    the caller SKIPs rather than FAILs."""


def role_url(role: str) -> str:
    return f"{FRONTEND_URL}/?role={role}"


# ---------------------------------------------------------------------------
# Reachability
# ---------------------------------------------------------------------------
def frontend_reachable(timeout_s: int = 5) -> bool:
    try:
        with urllib.request.urlopen(FRONTEND_URL, timeout=timeout_s) as resp:
            return resp.getcode() == 200
    except (urllib.error.URLError, OSError):
        return False


# ---------------------------------------------------------------------------
# toxiproxy hq-link control (the real DDIL sever mechanic — see ADR-0021)
# ---------------------------------------------------------------------------
def _toxiproxy_post(enabled: bool) -> None:
    body = json.dumps({"enabled": enabled}).encode()
    req = urllib.request.Request(
        f"{TOXIPROXY_API}/proxies/{HQ_LINK_PROXY}",
        data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        if resp.getcode() not in (200, 204):
            raise RuntimeError(f"toxiproxy returned HTTP {resp.getcode()}")


def hq_link_enabled() -> bool:
    """Current enabled-state of the hq-link proxy, straight from toxiproxy."""
    try:
        with urllib.request.urlopen(
            f"{TOXIPROXY_API}/proxies/{HQ_LINK_PROXY}", timeout=5
        ) as resp:
            return bool(json.loads(resp.read()).get("enabled", False))
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as e:
        raise UiUnavailable(f"toxiproxy hq-link not reachable: {e}") from e


def sever_hq_link() -> None:
    """Disable the toxiproxy hq-link proxy — a total WAN sever. The
    edge-hq-bridge can no longer reach redpanda-hq, `bridge-group` lag
    climbs, and the projector's edge-buffer monitor flips
    `edge_buffer_status.hq_link_severed` true."""
    _toxiproxy_post(False)


def restore_hq_link() -> None:
    """Re-enable the hq-link proxy. Idempotent — enabling an already-enabled
    proxy is a harmless no-op, so this doubles as a defensive reset."""
    _toxiproxy_post(True)


@contextlib.contextmanager
def severed_hq_link() -> Iterator[None]:
    """Sever the hq-link for the duration of the block, then ALWAYS restore
    it — even if the block raises. Tests 32/33 must never leave the link
    severed for the tests that follow them in run_all.py."""
    sever_hq_link()
    try:
        yield
    finally:
        restore_hq_link()


# ---------------------------------------------------------------------------
# Browser session
# ---------------------------------------------------------------------------
@contextlib.contextmanager
def browser_page(timeout_ms: int = DEFAULT_TIMEOUT_MS) -> Iterator:
    """Yield a Playwright `Page` on a headless Chromium, or raise
    `UiUnavailable` if Playwright, the browser binary, or the frontend is
    not available. The page records console errors and uncaught page
    errors on `page.console_errors` (a list) so tests can assert the view
    rendered without JS errors."""
    if not frontend_reachable():
        raise UiUnavailable(f"frontend not reachable at {FRONTEND_URL}")

    try:
        from playwright.sync_api import sync_playwright
    except ImportError as e:
        raise UiUnavailable(f"playwright not installed ({e})") from e

    try:
        pw = sync_playwright().start()
    except Exception as e:  # noqa: BLE001 - any runtime failure -> skip
        raise UiUnavailable(f"playwright runtime failed to start ({e})") from e

    browser = None
    try:
        try:
            browser = pw.chromium.launch(headless=True)
        except Exception as e:  # noqa: BLE001 - browser binary not installed
            raise UiUnavailable(
                f"chromium not installed — run `playwright install chromium` ({e})"
            ) from e
        context = browser.new_context(viewport={"width": 1600, "height": 1000})
        page = context.new_page()
        page.set_default_timeout(timeout_ms)

        # Surface JS errors so a view that "renders" but throws is still a
        # failure. console.error from expected-but-handled paths (e.g. a
        # toxiproxy fetch while the link is down) would be noise, so tests
        # opt in to checking this list rather than it being auto-fatal.
        page.console_errors = []  # type: ignore[attr-defined]
        page.on("console", lambda m: (
            page.console_errors.append(m.text)  # type: ignore[attr-defined]
            if m.type == "error" else None
        ))
        page.on("pageerror", lambda e: page.console_errors.append(str(e)))  # type: ignore[attr-defined]

        try:
            yield page
        finally:
            context.close()
    finally:
        if browser is not None:
            browser.close()
        pw.stop()


def open_view(page, role: str):
    """Navigate to a role view and wait for the SPA shell to mount.

    The dev nav bar ("OpenDDIL DEMO" + the role tabs) is always present
    once Root mounts, so it is the reliable "app is up" signal regardless
    of which role view is active or whether its shapes have synced yet."""
    page.goto(role_url(role), wait_until="domcontentloaded")
    page.get_by_text("OpenDDIL", exact=False).first.wait_for(state="visible")
    return page


def banner_notes(page) -> list[str]:
    """Text of every visible DEMO_MOCK banner on the current page. The
    banner renders `Demo Mock` or `Demo Mock — <note>` (DemoMockBanner)."""
    loc = page.locator("text=/Demo Mock/i")
    return [loc.nth(i).inner_text() for i in range(loc.count())]


# ---------------------------------------------------------------------------
# Test wrapper — maps a UI test body to the pass_/fail_/skip_ contract
# ---------------------------------------------------------------------------
def run_ui_test(name: str, body: Callable[[object], str]) -> None:
    """Run a UI test `body(page)` and map the outcome to the runner contract:

      - returns a detail string        -> PASS
      - raises UiUnavailable           -> SKIP (no browser / frontend down)
      - raises anything else           -> FAIL (assertion or Playwright
                                          timeout — the view did not render
                                          what the test required)

    As a defensive backstop, the hq-link proxy is restored after every UI
    test: tests 32/33 restore it themselves via `severed_hq_link()`, but a
    hard crash mid-block must not leave the pipeline severed for whatever
    runs next.
    """
    # Imported here (not at module top) so this helper file has no hard
    # dependency on _helpers' import side effects.
    from _helpers import fail_, pass_, skip_

    try:
        with browser_page() as page:
            detail = body(page)
    except UiUnavailable as e:
        _best_effort_restore()
        skip_(name, f"UI prerequisites unavailable — {e}")
        return  # unreachable (skip_ exits) — keeps type-checkers happy
    except Exception as e:  # noqa: BLE001 - assertion / timeout = real fail
        _best_effort_restore()
        fail_(name, f"{type(e).__name__}: {e}")
        return
    _best_effort_restore()
    pass_(name, detail or "ok")


def _best_effort_restore() -> None:
    try:
        restore_hq_link()
    except Exception:  # noqa: BLE001 - backstop only; never mask the verdict
        pass
