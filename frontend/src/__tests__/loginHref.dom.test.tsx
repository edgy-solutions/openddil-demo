// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { loginHref } from '../lib/loginHref';
import { SessionExpired } from '../components/SessionExpired';

describe('loginHref', () => {
  it('has no prompt by default', () => {
    expect(loginHref()).not.toContain('prompt');
  });

  it('forceLogin adds prompt=login and keeps the same next=', () => {
    const plain = loginHref();
    const forced = loginHref({ forceLogin: true });
    expect(forced).toBe(`${plain}&prompt=login`);
    expect(forced).toContain('next=');
  });
});

describe('SessionExpired', () => {
  it('says SESSION EXPIRED and signs in with prompt=login', () => {
    render(<SessionExpired />);
    expect(document.body.textContent).toContain('SESSION EXPIRED');
    const href = screen.getByRole('link', { name: /sign in/i }).getAttribute('href') ?? '';
    expect(href).toContain('prompt=login');
    expect(href).toContain('next=');
  });
});
