# Keycloak realm for the ADR-0029 read-path demo

**The reasoning lives here because the JSON cannot hold it.** Keycloak's
realm importer deserializes strictly and rejects any field it does not
know — a `_comment` key at the top level fails the import with
`Unrecognized field "_comment" ... not marked as ignorable`, and the
container exits. So the file next to this one carries no explanation at
all, and this is it.

*Second time in one session that a COMMENT broke the artifact it was
documenting* — the other was a dollar-brace example inside a Redpanda
Connect config, where environment interpolation is applied to the whole
file including comments. Worth the generalisation: **a comment is only
free where the format says it is**, and configuration formats consumed by
strict parsers frequently do not.

## Everything here is fiction

Atlantia (ATL) and Borduria (BDR) are invented nations. The users are
demo accounts with published passwords. This realm is for a lab and must
never be imported anywhere that matters.

## User ids are pinned, and that is the load-bearing detail

Keycloak's `sub` claim is the user's `id`, and left unset it is a fresh
UUID on every realm import. The entitlements corpus keys on `sub` (see
`policy/users.yaml`), so an unpinned id would mean every re-import
silently orphaned every entitlement — each user would authenticate
successfully and then be denied everything, which looks exactly like a
policy bug and is not one.

Pinning them also makes the corpus reviewable: a human reads
`users.yaml`, sees the id, and finds the same string here.

## The client is confidential and its redirect URI is exact

Contrast with the sibling project's UI client, which is `publicClient:
true` with `redirectUris: ["*"]`, `webOrigins: ["*"]` and
`directAccessGrantsEnabled: true`. Each of those is declined here
deliberately, and the reasons are in `gateway/oidc.py`.

Two placeholders are substituted at deploy time by the chart:
`__PEP_CLIENT_SECRET__` and `__PEP_REDIRECT_URI__`. They are DISTINCT
names on purpose — an earlier version used one shared literal told apart
by anchoring on what followed, and matched neither.

## The accounts

| username | id (`sub`) | in `users.yaml`? |
|---|---|---|
| `operator.atlantia` | `1111...1111` | yes — ATL |
| `operator.borduria` | `2222...2222` | yes — BDR |
| `liaison.coalition` | `3333...3333` | yes — ATL + BDR |
| `observer.unlisted` | `4444...4444` | **no, deliberately** |

### `observer.unlisted`

THE DEFAULT-DENY SUBJECT. This account authenticates successfully and
appears NOWHERE in policy/users.yaml, which is the entire point: the
demo's fourth beat proves that a valid identity with no entitlement
is refused BY DEFAULT rather than by a rule written about them.
It has to exist in Keycloak to be a real test. An account that could
not log in would prove that authentication works, which is a
different and much weaker claim than the one being made.
