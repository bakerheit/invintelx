import { useEffect, useState } from 'react';

/**
 * The value, but only once it has stopped changing for `delay` ms.
 *
 * A picker fires a search on every keystroke otherwise, and "BOLT-M6-30" is
 * eleven requests for one intention — the last of which is the only answer
 * anybody wanted.
 */
export function useDebounced<T>(value: T, delay = 250): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return settled;
}
