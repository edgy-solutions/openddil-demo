// paneEdgePoint pins a chip to the pane edge along a screen direction, inside a margin.
import { describe, expect, it } from 'vitest';
import { paneEdgePoint } from '../screenArrow';

const pane = { w: 800, h: 600 };
const chip = { w: 80, h: 20 };
const c = { x: 400, y: 300 };
// Inner box: x 52..748, y 22..578.

describe('paneEdgePoint', () => {
  it('right, left, up, down from the centre land on the inner box edge', () => {
    expect(paneEdgePoint(c, { x: 1, y: 0 }, pane, 12, chip)).toEqual({ x: 748, y: 300 });
    expect(paneEdgePoint(c, { x: -1, y: 0 }, pane, 12, chip)).toEqual({ x: 52, y: 300 });
    expect(paneEdgePoint(c, { x: 0, y: -1 }, pane, 12, chip)).toEqual({ x: 400, y: 22 });
    expect(paneEdgePoint(c, { x: 0, y: 1 }, pane, 12, chip)).toEqual({ x: 400, y: 578 });
  });

  it('a diagonal stops at the first boundary reached', () => {
    const p = paneEdgePoint(c, { x: 1, y: 1 }, pane, 12, chip);
    expect(p.y).toBeCloseTo(578);
    expect(p.x).toBeCloseTo(678);
  });

  it('clamps an origin outside the pane before marching', () => {
    expect(paneEdgePoint({ x: -500, y: 9000 }, { x: 1, y: 0 }, pane, 12, chip)).toEqual({ x: 748, y: 578 });
  });

  it('collapses an inverted interval to its midpoint on a tiny pane', () => {
    const p = paneEdgePoint({ x: 10, y: 10 }, { x: 1, y: 1 }, { w: 60, h: 20 }, 12, chip);
    expect(p).toEqual({ x: 30, y: 10 });
  });

  it('treats a zero or non-finite direction as right', () => {
    expect(paneEdgePoint(c, { x: 0, y: 0 }, pane, 12, chip)).toEqual({ x: 748, y: 300 });
    expect(paneEdgePoint(c, { x: Number.NaN, y: 1 }, pane, 12, chip)).toEqual({ x: 748, y: 300 });
  });
});
