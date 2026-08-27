import { describe, expect, it } from 'vitest';
import { DEFAULT_REDIRECT, isSafeRedirect, safeRedirect } from './redirect';

const TAB = String.fromCharCode(0x09);
const NEWLINE = String.fromCharCode(0x0a);
const CARRIAGE_RETURN = String.fromCharCode(0x0d);
const NULL_CHARACTER = String.fromCharCode(0x00);

/**
 * The destination a bounced user is sent back to after signing in. Nothing
 * hostile can reach it today, because the only thing that writes it is the app
 * reading its own location — so every case below is about the version of this
 * code that accepts the value from a query parameter or an emailed link, which
 * is the change these tests exist to survive.
 */
describe('isSafeRedirect', () => {
  it('accepts a plain in-app path', () => {
    expect(isSafeRedirect('/items')).toBe(true);
    expect(isSafeRedirect('/items/652f1c9a4b')).toBe(true);
  });

  it('accepts the filters a bounced user had applied', () => {
    // Losing the query string sends someone back to a screen that is not the
    // one they were on, which is the whole reason the destination is kept.
    expect(isSafeRedirect('/items?status=low&page=2&sort=-updatedAt')).toBe(true);
  });

  it('accepts the root path', () => {
    expect(isSafeRedirect('/')).toBe(true);
  });

  it('rejects a protocol-relative path, which leaves the origin', () => {
    // The browser reads what follows the two slashes as a host, not a path.
    expect(isSafeRedirect('//evil.example')).toBe(false);
    expect(isSafeRedirect('//evil.example/items')).toBe(false);
    expect(isSafeRedirect('///evil.example')).toBe(false);
  });

  it('rejects the backslash form browsers normalise to the same thing', () => {
    expect(isSafeRedirect('/\\evil.example')).toBe(false);
    expect(isSafeRedirect('/\\/evil.example')).toBe(false);
    expect(isSafeRedirect('\\\\evil.example')).toBe(false);
    expect(isSafeRedirect('\\/evil.example')).toBe(false);
  });

  it('rejects an absolute URL, whatever its scheme', () => {
    expect(isSafeRedirect('https://evil.example/items')).toBe(false);
    expect(isSafeRedirect('http://evil.example')).toBe(false);
    expect(isSafeRedirect('javascript:alert(1)')).toBe(false);
    expect(isSafeRedirect('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('rejects a bare relative path, whose destination depends on the current URL', () => {
    expect(isSafeRedirect('items')).toBe(false);
    expect(isSafeRedirect('./items')).toBe(false);
    expect(isSafeRedirect('../../evil.example')).toBe(false);
    expect(isSafeRedirect('')).toBe(false);
  });

  it('rejects a character the browser would strip before resolving the URL', () => {
    // Each of these reads as a single-slash path here and as protocol-relative
    // once the browser has removed the character in the middle.
    expect(isSafeRedirect('/' + TAB + '/evil.example')).toBe(false);
    expect(isSafeRedirect('/' + NEWLINE + '/evil.example')).toBe(false);
    expect(isSafeRedirect('/' + CARRIAGE_RETURN + '/evil.example')).toBe(false);
    expect(isSafeRedirect('/' + NULL_CHARACTER + '/evil.example')).toBe(false);
    expect(isSafeRedirect(' //evil.example')).toBe(false);
    expect(isSafeRedirect(TAB + 'https://evil.example')).toBe(false);
  });

  it('rejects anything that is not a string', () => {
    // Router state is whatever the previous screen put there, so it arrives
    // untyped and a missing `from` is the ordinary case.
    expect(isSafeRedirect(undefined)).toBe(false);
    expect(isSafeRedirect(null)).toBe(false);
    expect(isSafeRedirect(42)).toBe(false);
    expect(isSafeRedirect(['/items'])).toBe(false);
    expect(isSafeRedirect({ pathname: '/items' })).toBe(false);
  });
});

describe('safeRedirect', () => {
  it('hands back an in-app path unchanged', () => {
    expect(safeRedirect('/items?status=low')).toBe('/items?status=low');
  });

  it('falls back to the default rather than navigating off-site', () => {
    expect(safeRedirect('//evil.example')).toBe(DEFAULT_REDIRECT);
    expect(safeRedirect('https://evil.example')).toBe(DEFAULT_REDIRECT);
    expect(safeRedirect('/\\evil.example')).toBe(DEFAULT_REDIRECT);
  });

  it('falls back when there is no destination at all', () => {
    expect(safeRedirect(undefined)).toBe(DEFAULT_REDIRECT);
  });

  it('honours a caller-supplied fallback', () => {
    expect(safeRedirect('//evil.example', '/dashboard')).toBe('/dashboard');
  });

  it('does not let a hostile fallback through either', () => {
    // A fallback is a literal at every call site today. If one ever stops
    // being one, it is subject to the same rule as the target.
    expect(safeRedirect(undefined, '//evil.example')).toBe(DEFAULT_REDIRECT);
  });
});
