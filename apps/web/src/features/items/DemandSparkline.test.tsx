import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DemandSparkline } from './DemandSparkline';

/** The window is relative to "today", so the clock has to be pinned. */
const TODAY = new Date('2026-03-10T12:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TODAY);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DemandSparkline', () => {
  it('says so plainly when nothing has been issued', () => {
    render(<DemandSparkline series={[]} windowDays={90} unitOfMeasure="each" />);
    expect(screen.getByText(/nothing issued in the last 90 days/i)).toBeInTheDocument();
    // No empty chart frame pretending there is data behind it.
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('draws one bar per week of the window', () => {
    const { container } = render(
      <DemandSparkline
        series={[{ date: '2026-03-09', quantity: 5 }]}
        windowDays={28}
        unitOfMeasure="each"
      />,
    );
    expect(container.querySelectorAll('rect')).toHaveLength(4);
  });

  it('sums the days inside a week into one bar', () => {
    const { container } = render(
      <DemandSparkline
        series={[
          { date: '2026-03-09', quantity: 4 },
          { date: '2026-03-10', quantity: 6 },
        ]}
        windowDays={14}
        unitOfMeasure="each"
      />,
    );
    // Both days fall in the final week, so that bar carries 10.
    const titles = [...container.querySelectorAll('title')].map((t) => t.textContent);
    expect(titles.some((t) => t?.includes(': 10 each'))).toBe(true);
  });

  it('scales bars against the peak week, not against an arbitrary ceiling', () => {
    const { container } = render(
      <DemandSparkline
        series={[
          { date: '2026-02-26', quantity: 10 },
          { date: '2026-03-09', quantity: 20 },
        ]}
        windowDays={21}
        unitOfMeasure="each"
      />,
    );
    const heights = [...container.querySelectorAll('rect')].map((r) =>
      Number(r.getAttribute('height')),
    );
    const tallest = Math.max(...heights);
    const half = heights.filter((h) => h > 0 && h < tallest);
    expect(half[0]).toBeCloseTo(tallest / 2, 5);
  });

  it('reports the peak and total to a screen reader rather than only in pixels', () => {
    render(
      <DemandSparkline
        series={[
          { date: '2026-03-02', quantity: 3 },
          { date: '2026-03-09', quantity: 7 },
        ]}
        windowDays={14}
        unitOfMeasure="kg"
      />,
    );
    const chart = screen.getByRole('img');
    expect(chart).toHaveAttribute(
      'aria-label',
      expect.stringContaining('Peak week 7 kg, 10 in total'),
    );
  });

  it('ignores demand older than the window', () => {
    const { container } = render(
      <DemandSparkline
        series={[
          { date: '2025-01-01', quantity: 500 },
          { date: '2026-03-09', quantity: 2 },
        ]}
        windowDays={14}
        unitOfMeasure="each"
      />,
    );
    expect(screen.getByRole('img')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('2 in total'),
    );
    expect(container.querySelectorAll('rect')).toHaveLength(2);
  });
});
