// @vitest-environment jsdom
// Render cost of one holo track. R3F is mocked to passthrough, so <mesh> and
// <points> are inert DOM nodes and the geometries are real THREE objects;
// setAttribute on the prototype counts geometry builds, dispose counts frees.
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as THREE from 'three';

vi.mock('@react-three/fiber', () => ({
  useFrame: () => {},
  useThree: () => ({ size: { width: 800, height: 600 }, gl: { getPixelRatio: () => 1 } }),
}));
vi.mock('@react-three/drei', () => ({
  Html: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

import MunitionTrackHolo, { type MunitionTrackHoloProps, type Vec3 } from '../MunitionTrackHolo';

const track = { munitionAssetId: 'dis:9:9:1', launcherAssetId: null };
const trail: Vec3[] = [[0, 1, 0], [1, 2, 0], [2, 3, 1], [3, 4, 1]];
const props = (over: Partial<MunitionTrackHoloProps> = {}): MunitionTrackHoloProps => ({
  track, trail, groundY: 0, launcher: [0, 0, 0], target: [5, 0, 5], ...over,
});
const meshes = (c: HTMLElement) => c.querySelectorAll('mesh');
// The curtain is the only mesh at renderOrder 5.
const curtains = (c: HTMLElement) => Array.from(meshes(c)).filter((m) => m.getAttribute('renderorder') === '5');

const spyBuilt = () => vi.spyOn(THREE.BufferGeometry.prototype, 'setAttribute');
const spyFreed = () => vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
let built: ReturnType<typeof spyBuilt>;
let freed: ReturnType<typeof spyFreed>;
beforeEach(() => {
  built = spyBuilt();
  freed = spyFreed();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MunitionTrackHolo curtain prop', () => {
  it('renders one curtain mesh by default and with curtain=true', () => {
    expect(curtains(render(<MunitionTrackHolo {...props()} />).container)).toHaveLength(1);
    cleanup();
    expect(curtains(render(<MunitionTrackHolo {...props({ curtain: true })} />).container)).toHaveLength(1);
  });

  it('renders no curtain mesh, and builds one geometry fewer, with curtain=false', () => {
    const on = render(<MunitionTrackHolo {...props()} />).container;
    const meshesOn = meshes(on).length;
    cleanup();
    const before = built.mock.calls.length;
    const off = render(<MunitionTrackHolo {...props({ curtain: false })} />).container;
    expect(curtains(off)).toHaveLength(0);
    expect(meshes(off)).toHaveLength(meshesOn - 1);
    // Curtain geometry sets 3 attributes; it must not have been built.
    const offBuilds = built.mock.calls.length - before;
    cleanup();
    const before2 = built.mock.calls.length;
    render(<MunitionTrackHolo {...props()} />);
    expect(built.mock.calls.length - before2 - offBuilds).toBe(3);
  });
});

describe('MunitionTrackHolo geometry lifetime', () => {
  it('re-render with equal-valued launcher/target arrays builds and frees nothing', () => {
    const { rerender } = render(<MunitionTrackHolo {...props()} />);
    const builds = built.mock.calls.length;
    rerender(<MunitionTrackHolo {...props({ launcher: [0, 0, 0], target: [5, 0, 5] })} />);
    rerender(<MunitionTrackHolo {...props({ launcher: [0, 0, 0], target: [5, 0, 5] })} />);
    expect(built.mock.calls.length).toBe(builds);
    expect(freed).not.toHaveBeenCalled();
  });

  it('a changed target rebuilds only its geometries and frees the old ones', () => {
    const { rerender } = render(<MunitionTrackHolo {...props()} />);
    rerender(<MunitionTrackHolo {...props({ target: [6, 0, 5] })} />);
    expect(freed).toHaveBeenCalledTimes(2); // aim ribbon + reticle sprite
  });

  it('unmount disposes every geometry', () => {
    const { unmount } = render(<MunitionTrackHolo {...props()} />);
    expect(freed).not.toHaveBeenCalled();
    unmount();
    // trail, ground, curtain, drop, aim + sprites: foot, launch, reticle, head, lost, burst, shock
    expect(freed).toHaveBeenCalledTimes(12);
  });
});
