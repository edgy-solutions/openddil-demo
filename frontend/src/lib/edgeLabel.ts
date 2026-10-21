/** "SITE NAME · edge-id" when the site assignment carries a label, else the id. */
export function edgeLabel(id: string, fobs: { edge_id: string; label?: string }[]): string {
  const f = fobs.find((x) => x.edge_id === id);
  return f?.label ? `${f.label} · ${id}` : id;
}
