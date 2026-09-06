// =============================================================================
// labeledTables — which tables the gateway can partition, learned from it
// =============================================================================
// The browser must not guess this. The gateway refuses a table it cannot
// filter with cause `unlabelable`, and it publishes the list it enforces on
// /auth/me — so the explanation a panel shows and the refusal the gateway
// made come from ONE authority. Inferring "probably unlabelable" from a
// status code would be a second opinion about an authorization decision,
// which is the thing ADR-0029 §1 exists to forbid.
//
// Cached at module scope, filled by useSession's fetch. Before that fetch
// resolves, `isUnlabelable` answers false — an unknown reason is reported as
// a plain transport error, which understates rather than inventing a cause.
let labeled: string[] | null = null;

export function setLabeledTables(tables: string[] | undefined): void {
  labeled = Array.isArray(tables) ? tables : null;
}

/** True only when the gateway has told us its list AND this table is absent
 *  from it. An empty list from the gateway means the check is NOT CONFIGURED
 *  there, not that nothing is labeled — so it must not make every table
 *  read as unlabelable. */
export function isUnlabelable(table: string): boolean {
  if (!labeled || labeled.length === 0) return false;
  return !labeled.includes(table);
}
