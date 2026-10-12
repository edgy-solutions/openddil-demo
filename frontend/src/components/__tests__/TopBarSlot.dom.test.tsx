// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TopBarPortal, TopBarSlotProvider } from '../TopBarSlot';

afterEach(cleanup);

describe('TopBarPortal', () => {
  it('without a provider renders inline', () => {
    render(<TopBarPortal><span data-testid="kid">x</span></TopBarPortal>);
    expect(screen.getByTestId('top-bar-inline').contains(screen.getByTestId('kid'))).toBe(true);
  });

  it('with an attached element renders inside it and not inline', () => {
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    render(
      <TopBarSlotProvider value={slot}>
        <TopBarPortal><span data-testid="kid">x</span></TopBarPortal>
      </TopBarSlotProvider>,
    );
    expect(slot.contains(screen.getByTestId('kid'))).toBe(true);
    expect(screen.queryByTestId('top-bar-inline')).toBeNull();
    slot.remove();
  });

  it('with a null element renders nothing', () => {
    render(
      <TopBarSlotProvider value={null}>
        <TopBarPortal><span data-testid="kid">x</span></TopBarPortal>
      </TopBarSlotProvider>,
    );
    expect(screen.queryByTestId('kid')).toBeNull();
    expect(screen.queryByTestId('top-bar-inline')).toBeNull();
  });
});
