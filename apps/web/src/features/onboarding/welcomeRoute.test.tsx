import { Suspense, isValidElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { welcomeRoute } from './welcomeRoute';
import { router } from '@/routes/router';

interface RouteLike {
  path?: string;
  element?: ReactNode;
  children?: readonly unknown[];
}

function pathed(routes: readonly RouteLike[]): { path: string; element?: ReactNode }[] {
  return routes.flatMap((route) => [
    ...(route.path ? [{ path: route.path, element: route.element }] : []),
    ...pathed((route.children ?? []) as RouteLike[]),
  ]);
}

describe('welcomeRoute', () => {
  it('is an element the route table can hold as-is', () => {
    expect(isValidElement(welcomeRoute)).toBe(true);
  });

  /*
   * The welcome screen is reached once per instance and never again, so it has
   * no business in the chunk that every other screen waits for. A static import
   * would not fail anything obvious - it would quietly land in the first paint
   * a warehouse tablet on bad wifi stares at - so it fails here instead.
   */
  it('keeps the welcome screen out of the first paint', () => {
    expect(isValidElement(welcomeRoute) ? welcomeRoute.type : undefined).toBe(Suspense);
  });

  it('is what the router serves at /welcome', () => {
    const welcome = pathed(router.routes).find((route) => route.path === '/welcome');
    expect(welcome, '/welcome is routed').toBeDefined();
    expect(welcome?.element).toBe(welcomeRoute);
  });
});
