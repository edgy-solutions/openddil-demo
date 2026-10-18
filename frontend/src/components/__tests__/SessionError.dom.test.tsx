// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SessionError } from '../SignedOut';
import AppErrorBoundary from '../AppErrorBoundary';
import Root from '../../Root';
import { recordFailedRequest, __resetForTest } from '../../lib/lastFailedRequest';

const ERR = {
  method: 'GET' as const, path: '/auth/me' as const, status: 503,
  detail: 'Service Unavailable', attempts: 6, at: 1,
};

vi.mock('../../hooks/useSession', async (orig) => {
  const real = await orig<typeof import('../../hooks/useSession')>();
  return { ...real, useSession: () => ({
    authenticated: undefined, subject: null, username: '', name: '', nations: [],
    nationRegistry: [], role: 'observer', policyVersion: null, authDisabled: false,
    expiresAt: null, sessionError: ERR,
  }) };
});

afterEach(() => { cleanup(); __resetForTest(); });

describe('SessionError', () => {
  it('names the request, the status and the attempts', () => {
    const { container } = render(<SessionError error={ERR} />);
    expect(container.textContent).toContain('Could not confirm your session');
    expect(container.textContent).toContain('GET /auth/me → 503');
    expect(container.textContent).toContain('after 6 attempts');
    expect(screen.getByText('Retry')).toBeTruthy();
    expect(screen.getByText('Sign in again').getAttribute('href')).toContain('/auth/login?next=');
  });

  it('says network error when there was no status', () => {
    const { container } = render(<SessionError error={{ ...ERR, status: null }} />);
    expect(container.textContent).toContain('GET /auth/me → network error');
  });

  it('Root renders it in place of CHECKING SESSION', () => {
    const { container } = render(<Root />);
    expect(container.textContent).toContain('GET /auth/me → 503');
    expect(container.textContent).not.toContain('CHECKING SESSION');
  });
});

describe('AppErrorBoundary', () => {
  it('shows the thrown message and the last failed request', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    recordFailedRequest({ method: 'GET', path: '/shape/x', status: 502, detail: 'Bad Gateway', at: 1 });
    function Boom(): never { throw new Error('kaboom'); }
    const { container } = render(<AppErrorBoundary><Boom /></AppErrorBoundary>);
    expect(container.textContent).toContain('kaboom');
    expect(container.textContent).toContain('Last failed request: GET /shape/x → 502 (Bad Gateway)');
    expect(screen.getByText('Reload')).toBeTruthy();
  });
});
