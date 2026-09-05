// =============================================================================
// thisNode — may this screen claim to BE the node it is showing?
// =============================================================================
// The badge these tests defend was, until 2026-09-05, unconditional. The
// demo shell's maintainer tab rendered `TACTICAL EDGE [THIS NODE]` on the
// HQ host: a composed edge view asserting it was the node you had connected
// to. It is the mode confusion the tier arc was opened for, surviving inside
// the one component that composes tiers.
//
// The rule is narrow and these tests are mostly about the NEGATIVE cases,
// because the failure mode is claiming identity, never withholding it.
import { describe, it, expect, beforeEach } from 'vitest';
import { isThisNode } from '../thisNodeContext';
import { __setDeploymentForTest } from '../../deployment';
import type { TierConfig } from '../../deployment';

const EDGE_01: TierConfig = {
  id: 'edge-01', label: 'edge-01', scope: null,
  has_children: false, parent: 'region-east',
};
const EDGE_02: TierConfig = {
  id: 'edge-02', label: 'edge-02', scope: null,
  has_children: false, parent: 'region-east',
};
const SHELL_LEAF: TierConfig = {
  id: 'shell-leaf', label: 'maintainer', scope: null,
  has_children: false, parent: 'shell-intermediate',
};

describe('isThisNode', () => {
  beforeEach(() => __setDeploymentForTest(undefined));

  it('is true only for the tier this deployment serves', () => {
    __setDeploymentForTest(EDGE_01);
    expect(isThisNode(EDGE_01)).toBe(true);
  });

  it('is FALSE for a different tier of the same shape', () => {
    // Two leaves have identical shapes and are different nodes. Identity is
    // the id and only the id — a shape comparison would have every edge
    // claiming to be every other edge.
    __setDeploymentForTest(EDGE_01);
    expect(isThisNode(EDGE_02)).toBe(false);
  });

  it('is FALSE for every tier when the deployment serves none', () => {
    // The demo shell's case. It composes tiers and is not any of them, so
    // no tab may claim node identity. This is the regression that mattered.
    __setDeploymentForTest(null);
    expect(isThisNode(SHELL_LEAF)).toBe(false);
    expect(isThisNode(EDGE_01)).toBe(false);
  });

  it('is FALSE for a null tier rather than throwing', () => {
    __setDeploymentForTest(EDGE_01);
    expect(isThisNode(null)).toBe(false);
    expect(isThisNode(undefined)).toBe(false);
  });
});
