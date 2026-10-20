import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadImage } from '../terrainData';

class FakeImage {
  static last: FakeImage | null = null;
  crossOrigin = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  constructor() { FakeImage.last = this; }
}

describe('loadImage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('Image', FakeImage);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('resolves the image on load', async () => {
    const p = loadImage('t/1.png', 1000);
    const img = FakeImage.last!;
    img.onload!();
    expect(await p).toBe(img);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves null on error and clears the timer', async () => {
    const p = loadImage('t/1.png', 1000);
    FakeImage.last!.onerror!();
    expect(await p).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves null on timeout, detaches handlers and clears src', async () => {
    const p = loadImage('t/1.png', 1000);
    const img = FakeImage.last!;
    expect(img.src).toBe('t/1.png');
    vi.advanceTimersByTime(1000);
    expect(await p).toBeNull();
    expect(img.onload).toBeNull();
    expect(img.onerror).toBeNull();
    expect(img.src).toBe('');
  });
});
