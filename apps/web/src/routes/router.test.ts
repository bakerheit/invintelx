import { describe, expect, it } from 'vitest';
import { router } from './router';
import { NAV_ITEMS } from '@/components/nav';

/** Every path the router knows about, flattened out of the nested config. */
function paths(routes: readonly { path?: string; children?: readonly unknown[] }[]): string[] {
  return routes.flatMap((route) => [
    ...(route.path ? [route.path] : []),
    ...paths((route.children ?? []) as Parameters<typeof paths>[0]),
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

  it('still treats the unbuilt sections as unbuilt', () => {
    const planned = NAV_ITEMS.filter((item) => item.planned).map((item) => item.to);
    expect(planned).not.toContain('/movements');
  });
});
