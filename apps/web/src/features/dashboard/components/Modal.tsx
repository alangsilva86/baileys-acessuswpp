import type { ReactNode } from 'react';

type ModalProps = {
  open: boolean;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  onClose?: () => void;
};

export default function Modal({
  open,
  title,
  description,
  children,
  footer,
  onClose,
}: ModalProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        className="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl"
      >
        <div className="space-y-1">
          <h3 id="modal-title" className="text-lg font-semibold text-slate-900">{title}</h3>
          {description ? <p className="text-sm text-slate-500">{description}</p> : null}
        </div>
        <div className="mt-4 space-y-4">
          {children}
          {footer ? <div className="flex justify-end gap-2">{footer}</div> : null}
        </div>
      </div>
    </div>
  );
}
