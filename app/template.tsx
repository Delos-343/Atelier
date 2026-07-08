'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * App-wide page transition. `template.tsx` re-mounts on every navigation, so a
 * simple enter animation gives each route a gentle cross-fade. Deliberately
 * OPACITY-ONLY: a lingering transform on this wrapper would reparent any
 * `position: sticky`/`fixed` descendants, so we never translate here. Printable
 * document routes and reduced-motion users bypass it entirely.
 */
export default function Template({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion();
  const pathname = usePathname();

  if (reduced || pathname.startsWith('/print')) return <>{children}</>;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  );
}
