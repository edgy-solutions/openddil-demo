// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PostureHeader } from '../PostureHeader';

describe('PostureHeader', () => {
  afterEach(cleanup);

  it('draws the eyebrow, title, rule and meta by default', () => {
    render(<PostureHeader eyebrow="HQ · THEATER" title="THEATER READINESS POSTURE" meta="3 FOBS" />);
    const header = screen.getByTestId('posture-header');
    expect(header.textContent).toContain('HQ · THEATER');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('THEATER READINESS POSTURE');
    expect(header.textContent).toContain('3 FOBS');
    expect(screen.getByTestId('posture-header-rule')).toBeTruthy();
    expect(screen.queryByTestId('posture-header-severed')).toBeNull();
  });

  it('turns rose and tags LINK SEVERED when severed', () => {
    render(<PostureHeader eyebrow="HQ · THEATER" title="T" meta="m" severed />);
    expect(screen.getByTestId('posture-header-severed').textContent).toBe('LINK SEVERED');
    expect(screen.getByRole('heading', { level: 1 }).className).toContain('text-rose-400');
    expect(screen.getByTestId('posture-header-rule').className).toContain('from-rose-500/70');
  });

  it('frames the plate variant with corner brackets and no rule', () => {
    render(<PostureHeader eyebrow="e" title="T" meta="m" variant="plate" />);
    expect(screen.queryByTestId('posture-header-rule')).toBeNull();
    expect(screen.getByTestId('posture-header').querySelectorAll('span.absolute')).toHaveLength(4);
  });

  it('renders children under the meta line', () => {
    render(<PostureHeader eyebrow="e" title="T" meta="m"><button type="button">OVERVIEW</button></PostureHeader>);
    expect(screen.getByTestId('posture-header').querySelector('button')?.textContent).toBe('OVERVIEW');
  });
});
