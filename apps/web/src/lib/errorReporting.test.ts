import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientErrorReport } from '@invintelx/shared';
import {
  installGlobalErrorReporting,
  noteFailedRequest,
  reportClientError,
  resetErrorReporting,
} from './errorReporting';

/**
 * The browser end of error tracking.
 *
 * What is actually load-bearing here is the restraint: a broken render throws
 * on every attempt, so a reporter without a cap turns one bug into an unbounded
 * stream of identical POSTs from every open tab — a self-inflicted flood that
 * buries the error it was reporting.
 */

const fetchMock = vi.fn();

function sentReports(): ClientErrorReport[] {
  return fetchMock.mock.calls.map(
    (call) => JSON.parse((call[1] as { body: string }).body) as ClientErrorReport,
  );
}

beforeEach(() => {
  resetErrorReporting();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sending a report', () => {
  it('posts it to the API', () => {
    expect(reportClientError(new TypeError('cannot read x of undefined'))).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/client-errors');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
  });

  it('carries the message, the name and the stack', () => {
    reportClientError(new TypeError('cannot read x of undefined'));
    expect(sentReports()[0]).toMatchObject({
      kind: 'error',
      name: 'TypeError',
      message: 'cannot read x of undefined',
    });
    expect(sentReports()[0]?.stack).toContain('TypeError');
  });

  it('survives a throw that was not an Error', () => {
    reportClientError('just a string', { kind: 'unhandledrejection' });
    expect(sentReports()[0]).toMatchObject({
      kind: 'unhandledrejection',
      message: 'just a string',
    });
  });

  it('says which page it happened on', () => {
    reportClientError(new Error('boom'));
    expect(sentReports()[0]?.url).toBe(window.location.href);
  });

  it('outlives the navigation that caused it', () => {
    // The error that matters most is the one during a navigation away; without
    // keepalive the browser cancels the request as the page unloads.
    reportClientError(new Error('boom'));
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ keepalive: true });
  });

  it('reports nothing for an error with no message at all', () => {
    reportClientError(new Error(''));
    // `new Error('')` still has a name, which is better than an empty line.
    expect(sentReports()[0]?.message).toBe('Error');
  });
});

describe('not becoming the flood', () => {
  it('reports a repeated error once per page load', () => {
    reportClientError(new TypeError('the same bug'));
    expect(reportClientError(new TypeError('the same bug'))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still reports a different error', () => {
    reportClientError(new TypeError('one bug'));
    reportClientError(new TypeError('a different bug'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops after a hard cap, however many distinct errors arrive', () => {
    for (let i = 0; i < 50; i += 1) reportClientError(new Error(`bug ${String(i)}`));
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it('does not report the reporter failing', () => {
    fetchMock.mockRejectedValue(new Error('network is gone'));
    expect(() => reportClientError(new Error('boom'))).not.toThrow();
  });

  it('does not throw when fetch itself is unavailable', () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('no fetch here');
    });
    expect(reportClientError(new Error('boom'))).toBe(false);
  });
});

describe('joining the two sides of one bug', () => {
  it('names the API request that failed just before', () => {
    noteFailedRequest('req-from-the-500');
    reportClientError(new Error('the render that followed'));
    expect(sentReports()[0]?.requestId).toBe('req-from-the-500');
  });

  it('prefers an id given explicitly over the last one seen', () => {
    noteFailedRequest('an-older-failure');
    reportClientError(new Error('boom'), { requestId: 'the-one-that-broke-this' });
    expect(sentReports()[0]?.requestId).toBe('the-one-that-broke-this');
  });

  it('sends no id at all when there was no failed request', () => {
    reportClientError(new Error('boom'));
    expect(sentReports()[0]?.requestId).toBeUndefined();
  });
});

describe('what React cannot catch', () => {
  it('reports an error that never went near a component', () => {
    const uninstall = installGlobalErrorReporting();

    // A throw inside a setTimeout bypasses every boundary React has.
    window.dispatchEvent(
      Object.assign(new Event('error'), { error: new Error('from a timer'), message: 'ignored' }),
    );

    expect(sentReports()[0]).toMatchObject({ kind: 'error', message: 'from a timer' });
    uninstall();
  });

  it('reports a rejection nobody handled', () => {
    const uninstall = installGlobalErrorReporting();

    window.dispatchEvent(
      Object.assign(new Event('unhandledrejection'), { reason: new Error('nobody awaited this') }),
    );

    expect(sentReports()[0]).toMatchObject({
      kind: 'unhandledrejection',
      message: 'nobody awaited this',
    });
    uninstall();
  });

  it('stops listening once uninstalled', () => {
    const uninstall = installGlobalErrorReporting();
    uninstall();

    window.dispatchEvent(Object.assign(new Event('error'), { error: new Error('after') }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
