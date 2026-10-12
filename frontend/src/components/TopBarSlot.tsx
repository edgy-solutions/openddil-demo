import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// The top bar (in Root) owns a slot element; a tier header portals its compact
// controls into it. undefined = no provider (tests, other callers): render
// inline. null = provider present but the slot is not attached yet: render
// nothing. An element: portal into it.
const TopBarSlotContext = createContext<HTMLElement | null | undefined>(undefined);

// eslint-disable-next-line react-refresh/only-export-components
export const TopBarSlotProvider = TopBarSlotContext.Provider;

export function TopBarPortal({ children }: { children: ReactNode }) {
  const el = useContext(TopBarSlotContext);
  if (el === undefined) {
    return (
      <div
        data-testid="top-bar-inline"
        className="flex items-center gap-3 px-4 py-1.5 shrink-0 border-b border-slate-800 bg-slate-900"
      >
        {children}
      </div>
    );
  }
  if (el === null) return null;
  return createPortal(<>{children}</>, el);
}
