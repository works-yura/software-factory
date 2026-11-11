import { useEffect, useState } from 'react';

const MINUTE_MS = 60_000;

/** The time now, read again every minute: reset countdowns stay current while a view stays open. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}
