/**
 * Rendered in UTC, deliberately.
 *
 * The demand series groups movements into UTC days, so rendering the history in
 * local time makes the two disagree: a movement counted in Thursday's demand
 * bucket displays as Wednesday for anyone west of Greenwich, and reconciling the
 * sparkline against this table becomes impossible. One definition of "what day
 * did this happen", used everywhere — which is why it lives here rather than
 * beside any one screen.
 */
export function formatMovementDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
