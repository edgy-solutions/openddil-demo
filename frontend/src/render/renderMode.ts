// =============================================================================
// renderMode — selectable 3D render modes (MATTE / METALLIC / HOLOGRAPHIC)
// =============================================================================
// MATTE is today's look and the default. The mode reaches the schematics via
// context; the Provider is mounted INSIDE each <Canvas> (R3F does not bridge
// React context across the reconciler boundary). Trees with no provider (the
// regional map, HQ views) read the default and so stay MATTE.
import { createContext, useCallback, useContext, useState } from 'react';

export type RenderMode = 'matte' | 'metallic' | 'holographic';

export const RENDER_MODES: readonly RenderMode[] = ['matte', 'metallic', 'holographic'];

export const RENDER_MODE_LABELS: Record<RenderMode, string> = {
  matte: 'MATTE',
  metallic: 'METALLIC',
  holographic: 'HOLOGRAPHIC',
};

export const RENDER_MODE_STORAGE_KEY = 'openddil.renderMode';

export const RenderModeContext = createContext<RenderMode>('matte');
export const RenderModeProvider = RenderModeContext.Provider;

export function useRenderMode(): RenderMode {
  return useContext(RenderModeContext);
}

export function isRenderMode(v: unknown): v is RenderMode {
  return typeof v === 'string' && (RENDER_MODES as readonly string[]).includes(v);
}

export function readRenderModePreference(): RenderMode {
  try {
    const v = window.localStorage.getItem(RENDER_MODE_STORAGE_KEY);
    return isRenderMode(v) ? v : 'matte';
  } catch {
    return 'matte';
  }
}

export function writeRenderModePreference(mode: RenderMode): void {
  try {
    window.localStorage.setItem(RENDER_MODE_STORAGE_KEY, mode);
  } catch {
    /* storage unavailable: the choice just does not persist */
  }
}

/** Persisted render-mode state. Invalid / unreadable storage falls back to matte. */
export function useRenderModePreference(): [RenderMode, (m: RenderMode) => void] {
  const [mode, setModeState] = useState<RenderMode>(readRenderModePreference);
  const setMode = useCallback((m: RenderMode) => {
    if (!isRenderMode(m)) return;
    setModeState(m);
    writeRenderModePreference(m);
  }, []);
  return [mode, setMode];
}
