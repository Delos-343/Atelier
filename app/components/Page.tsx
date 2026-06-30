import type { ReactNode } from 'react';

/** Standard page shell: centered, max-width, responsive padding. */
export function Page({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto max-w-content px-5 pb-16 pt-[clamp(1.75rem,5vw,3rem)]">{children}</main>
  );
}

/** Page title + optional justified description. */
export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="mb-7">
      <h1 className="text-[clamp(1.7rem,4.5vw,2.4rem)] font-semibold leading-[1.1] tracking-[-0.02em]">
        {title}
      </h1>
      {children && <p className="prose-justify mt-2 max-w-[62ch] text-muted">{children}</p>}
    </header>
  );
}
