// =============================================================================
// loginHref — return to the same view after signing in
// =============================================================================
// The view is the URL (role, and now the selected asset, both round-trip
// through query params — see MaintainerApp.tsx). So "return to the same
// view after login" is exactly "send the gateway back to this path and
// query string", validated gateway-side by oidc.safe_next before it is
// ever acted on.
export function loginHref(): string {
  const next = encodeURIComponent(window.location.pathname + window.location.search);
  return `/auth/login?next=${next}`;
}
