import { useEffect, useRef } from 'react';
import type { TermSession } from '../terminal';

/** Hosts one xterm instance; `active` focuses it. */
export function TermView({ session, active }: { session: TermSession; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current!;
    session.attach(el);
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => session.fit());
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [session]);

  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => {
      session.fit();
      session.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active, session]);

  return <div className="term-host" ref={ref} />;
}
