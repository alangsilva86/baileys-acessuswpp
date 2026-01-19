export type ToastTone = 'success' | 'error' | 'info';

export type ToastItem = {
  id: string;
  message: string;
  tone?: ToastTone;
  title?: string;
};

type ToastStackProps = {
  items: ToastItem[];
  onDismiss: (id: string) => void;
};

const TONE_STYLES: Record<ToastTone, { container: string; message: string }> = {
  success: {
    container: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    message: 'text-emerald-700',
  },
  error: {
    container: 'border-rose-200 bg-rose-50 text-rose-900',
    message: 'text-rose-700',
  },
  info: {
    container: 'border-slate-200 bg-white text-slate-900',
    message: 'text-slate-600',
  },
};

const DEFAULT_TONE: ToastTone = 'info';

export default function ToastStack({ items, onDismiss }: ToastStackProps) {
  if (!items.length) return null;

  return (
    <div className="fixed right-6 top-6 z-50 space-y-2">
      {items.map((toast) => {
        const tone = toast.tone ?? DEFAULT_TONE;
        const styles = TONE_STYLES[tone] ?? TONE_STYLES.info;
        return (
          <div
            key={toast.id}
            className={`w-72 rounded-xl border px-4 py-3 shadow-lg ${styles.container}`}
            role="status"
            aria-live="polite"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                {toast.title ? <div className="text-sm font-semibold">{toast.title}</div> : null}
                <div className={`text-xs ${styles.message}`}>{toast.message}</div>
              </div>
              <button
                type="button"
                onClick={() => onDismiss(toast.id)}
                className="text-xs text-slate-500 hover:text-slate-700"
                aria-label="Fechar"
              >
                Fechar
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
