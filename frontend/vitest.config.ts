/// <reference types="vitest" />
// Vitest configuration. Test layout: src/**/__tests__/*.test.ts(x). Pure
// unit tests only — no jsdom needed for the ones we have today (pill
// mappings, severity color, layout-math formulas are all pure-logic).
// If a future test needs DOM, add `environment: 'jsdom'` here and the
// jsdom devDependency.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
