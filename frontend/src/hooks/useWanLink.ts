// =============================================================================
// useWanLink — React wrapper over the WAN proxy controller
// =============================================================================
// Thin on purpose: all the effectful logic (GET on mount, POST on set, the
// "unknown" failure state) lives in lib/wanLink.ts's framework-free
// controller, which is what the unit tests exercise directly. This hook
// only adds the React plumbing (one controller instance per mount,
// re-render on state change) and is used identically by MaintainerApp,
// RegionalApp and HqApp, implemented once rather than duplicated per
// view. ControllerApp's toxics code is out of scope here.
import { useEffect, useRef, useState } from 'react';
import { createWanLinkController } from '../lib/wanLink';

export interface UseWanLinkResult {
  /** null = unknown (still loading, or the GET failed). The UI must render
   *  this as a disabled control, never guess true/false. */
  enabled: boolean | null;
  /** POST the desired state. Call only from the user's own toggle handler. */
  set(value: boolean): void;
  /** True when the most recent GET or POST failed. */
  error: boolean;
}

export function useWanLink(): UseWanLinkResult {
  const controllerRef = useRef(createWanLinkController());
  const [state, setState] = useState(() => controllerRef.current.getState());

  useEffect(() => {
    const controller = controllerRef.current;
    const unsubscribe = controller.subscribe(() => setState(controller.getState()));
    // GET on mount only — never a POST. See lib/wanLink.ts.
    void controller.init();
    return unsubscribe;
  }, []);

  return {
    enabled: state.enabled,
    error: state.error,
    set: (value: boolean) => { void controllerRef.current.set(value); },
  };
}
