// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { RENDER_MODE_STORAGE_KEY, useRenderModePreference } from '../renderMode';

describe('useRenderModePreference', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('defaults to matte', () => {
    const { result } = renderHook(() => useRenderModePreference());
    expect(result.current[0]).toBe('matte');
  });

  it('persists a selection and restores it', () => {
    const first = renderHook(() => useRenderModePreference());
    act(() => first.result.current[1]('holographic'));
    expect(first.result.current[0]).toBe('holographic');
    expect(window.localStorage.getItem(RENDER_MODE_STORAGE_KEY)).toBe('holographic');
    const second = renderHook(() => useRenderModePreference());
    expect(second.result.current[0]).toBe('holographic');
  });

  it('rejects invalid stored values', () => {
    window.localStorage.setItem(RENDER_MODE_STORAGE_KEY, 'chrome');
    const { result } = renderHook(() => useRenderModePreference());
    expect(result.current[0]).toBe('matte');
  });

  it('survives a throwing localStorage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useRenderModePreference());
    expect(result.current[0]).toBe('matte');
    act(() => result.current[1]('metallic'));
    expect(result.current[0]).toBe('metallic');
  });
});
