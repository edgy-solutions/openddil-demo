// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RenderModeMenu } from '../RenderModeMenu';

describe('RenderModeMenu', () => {
  afterEach(cleanup);

  it('has menu aria attributes and starts closed', () => {
    render(<RenderModeMenu mode="matte" onChange={() => {}} />);
    const btn = screen.getByRole('button', { name: /render mode: matte/i });
    expect(btn.getAttribute('aria-haspopup')).toBe('menu');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens, lists three modes, marks the current one, and selects', () => {
    const onChange = vi.fn();
    render(<RenderModeMenu mode="metallic" onChange={onChange} />);
    const btn = screen.getByRole('button', { name: /render mode/i });
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual(['MATTE', 'METALLIC', 'HOLOGRAPHIC']);
    expect(items[1].getAttribute('aria-checked')).toBe('true');
    fireEvent.click(items[2]);
    expect(onChange).toHaveBeenCalledWith('holographic');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('arrow keys move focus and Escape closes', () => {
    render(<RenderModeMenu mode="matte" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /render mode/i }));
    const items = screen.getAllByRole('menuitemradio');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowUp' });
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on outside click', () => {
    render(<RenderModeMenu mode="matte" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /render mode/i }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
