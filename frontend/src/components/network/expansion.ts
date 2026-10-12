// Which link row is expanded inside the network popover. Held by the popover
// (not by the rows) so Escape can collapse the expanded row BEFORE it closes
// the popover.
import { createContext, useContext } from 'react';

export interface ExpansionState {
  expanded: string | null;
  toggle: (key: string) => void;
}

export const ExpansionContext = createContext<ExpansionState | null>(null);

export function useExpansion(key: string): { open: boolean; toggle: () => void } {
  const ctx = useContext(ExpansionContext);
  return { open: ctx?.expanded === key, toggle: () => ctx?.toggle(key) };
}
