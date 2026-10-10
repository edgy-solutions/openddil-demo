// =============================================================================
// useLinkControl — React wrapper over the link-control controller
// =============================================================================
// Thin on purpose: the effectful logic (listing, POST, unknown states) lives
// in lib/linkControl.ts's framework-free controller, which the unit tests
// exercise directly. This hook adds one controller per mount, a 5 s poll
// (so both ends of a link converge) and re-render on state change. It never
// POSTs except through `set`, which callers invoke only from a change handler.
import { useEffect, useState } from 'react';
import {
  createLinkControlController,
  type ChildLinkControl,
  type LinkControlStatus,
  type UplinkControl,
} from '../lib/linkControl';

export interface UseLinkControlResult {
  status: LinkControlStatus;
  uplink: UplinkControl | null;
  children: ChildLinkControl[];
  /** 'uplink' or a direct child's id. */
  set(target: 'uplink' | string, value: boolean): void;
}

export function useLinkControl(): UseLinkControlResult {
  const [controller] = useState(() => createLinkControlController());
  const [state, setState] = useState(() => controller.getState());

  useEffect(() => {
    const unsubscribe = controller.subscribe(() => setState(controller.getState()));
    void controller.refresh();
    const timer = setInterval(() => { void controller.refresh(); }, 5000);
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [controller]);

  return {
    status: state.status,
    uplink: state.uplink,
    children: state.children,
    set: (target: string, value: boolean) => { void controller.set(target, value); },
  };
}
