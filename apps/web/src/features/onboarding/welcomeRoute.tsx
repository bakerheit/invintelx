import { Suspense, lazy } from 'react';
import { RouteFallback } from '@/routes/RouteFallback';

/*
 * The welcome screen, behind a dynamic import.
 *
 * It is the one screen nobody sees twice. An instance that has been set up
 * navigates past it and never comes back, so shipping it inside the chunk every
 * other screen waits for would charge every load for a page almost nobody is
 * about to open.
 *
 * The route table gets a ready-made element rather than a component, so the
 * boundary is part of what `/welcome` *is* rather than something the router has
 * to remember to wrap it in.
 */
const WelcomePage = lazy(() =>
  import('./WelcomePage').then((m) => ({ default: m.WelcomePage })),
);

export const welcomeRoute = (
  <Suspense fallback={<RouteFallback />}>
    <WelcomePage />
  </Suspense>
);
