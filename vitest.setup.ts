import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

/*
 * Testing Library only auto-cleans when Vitest globals are on. They are not, so
 * unmount explicitly - otherwise every render stacks up in the same document
 * and queries start finding several copies of the same element.
 */
afterEach(() => {
  cleanup();
});

/*
 * jsdom implements neither of these, and Radix uses both. Without the stubs
 * every dialog and select test dies on "is not a function" before it can assert
 * anything about the component.
 */
if (typeof window !== 'undefined') {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }

  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof window.ResizeObserver;
  }

  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
}
