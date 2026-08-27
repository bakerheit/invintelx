/**
 * Shown while a route's chunk is in flight. Every screen is loaded on demand,
 * so on a slow connection this is what stands in for the page — a spinner
 * rather than nothing, because a blank frame reads as a broken app.
 */
export function RouteFallback() {
  return (
    <div className="flex min-h-64 items-center justify-center py-12">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
      <span className="sr-only">Loading</span>
    </div>
  );
}
