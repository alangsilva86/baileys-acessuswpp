import type { ReactNode } from 'react';

type LayoutShellProps = {
  header?: ReactNode;
  sidebar: ReactNode;
  main: ReactNode;
};

export default function LayoutShell({ header, sidebar, main }: LayoutShellProps) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100 text-slate-900">
      <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-6 py-6">
        {header ? <header className="rounded-2xl border border-slate-100 bg-white/70 px-5 py-4 shadow-sm backdrop-blur">{header}</header> : null}
        <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
          <aside className="h-full rounded-2xl border border-slate-100 bg-white/70 shadow-sm backdrop-blur">
            {sidebar}
          </aside>
          <main className="h-full rounded-2xl border border-slate-100 bg-slate-50/95 shadow-sm">
            {main}
          </main>
        </div>
      </div>
    </div>
  );
}
