import { Suspense, isValidElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { router } from './router';
import { NAV_ITEMS } from '@/components/nav';

interface RouteLike {
  path?: string;
  element?: ReactNode;
  children?: readonly unknown[];
}

/** Every path the router knows about, flattened out of the nested config. */
function paths(routes: readonly { path?: string; children?: readonly unknown[] }[]): string[] {
  return routes.flatMap((route) => [
    ...(route.path ? [route.path] : []),
    ...paths((route.children ?? []) as Parameters<typeof paths>[0]),
  ]);
}

/** Every pathed route, flattened, with whatever it renders. */
function pathed(routes: readonly RouteLike[]): { path: string; element?: ReactNode }[] {
  return routes.flatMap((route) => [
    ...(route.path ? [{ path: route.path, element: route.element }] : []),
    ...pathed((route.children ?? []) as RouteLike[]),
  ]);
}

describe('router', () => {
  it('serves the movements screen', () => {
    expect(paths(router.routes)).toContain('/movements');
  });

  /*
   * The sidebar greys out sections whose epics have not landed and refuses to
   * link them. A nav entry that is live but unrouted is a 404 in the sidebar,
   * which is the exact failure this pairing exists to prevent — so the two are
   * checked against each other rather than trusted to be edited together.
   */
  it('routes every section the sidebar offers as built', () => {
    const routed = paths(router.routes);
    for (const item of NAV_ITEMS) {
      if (item.planned) continue;
      expect(routed, `${item.label} is in the sidebar`).toContain(item.to);
    }
  });

  /*
   * The bundle is split by route, and it only stays split for as long as every
   * new screen is added the same way. A statically imported page would not
   * fail anything obvious — it would just quietly land in the first paint that
   * a warehouse tablet on bad wifi waits for — so it fails here instead.
   *
   * The exceptions are deliberate: `/` is a redirect that renders no screen,
   * and `*` is the not-found page, which is one of the things that renders
   * when a chunk could not be fetched.
   */
  it('loads every screen on demand', () => {
    const eager = new Set(['/', '*']);

    for (const route of pathed(router.routes)) {
      if (eager.has(route.path)) continue;
      const rendered = isValidElement(route.element) ? route.element.type : undefined;
      expect(rendered, `${route.path} is behind a dynamic import`).toBe(Suspense);
    }
  });

  it('still treats the unbuilt sections as unbuilt', () => {
    const planned = NAV_ITEMS.filter((item) => item.planned).map((item) => item.to);
    expect(planned).not.toContain('/movements');
  });
});
