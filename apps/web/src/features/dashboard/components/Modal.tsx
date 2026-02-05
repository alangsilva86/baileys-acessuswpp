import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => {
    if (el.hasAttribute('disabled')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    return true;
  });
}

function focusDialog(container: HTMLElement): void {
  const focusables = getFocusableElements(container);
  const target = focusables[0] || container;
  if (typeof target.focus === 'function') target.focus();
}

function trapFocus(ev: KeyboardEvent, container: HTMLElement): void {
  if (ev.key !== 'Tab') return;
  const focusables = getFocusableElements(container);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;

  if (!container.contains(active)) {
    ev.preventDefault();
    first.focus();
    return;
  }

  if (ev.shiftKey && (active === first || active === container)) {
    ev.preventDefault();
    last.focus();
    return;
  }

  if (!ev.shiftKey && (active === last || active === container)) {
    ev.preventDefault();
    first.focus();
  }
}

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
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    if (typeof document === 'undefined') return undefined;

    lastFocusedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    const attemptFocus = () => focusDialog(dialog);
    window.setTimeout(attemptFocus, 0);
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(attemptFocus);

    const handleKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        if (!onClose) return;
        ev.preventDefault();
        ev.stopPropagation();
        onClose();
        return;
      }
      if (ev.key === 'Tab') {
        trapFocus(ev, dialog);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = prevOverflow;
      const previous = lastFocusedRef.current;
      lastFocusedRef.current = null;
      if (previous && typeof previous.focus === 'function') {
        window.setTimeout(() => previous.focus(), 0);
      }
    };
  }, [open, onClose]);

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
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        ref={dialogRef}
        className="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl"
      >
        <div className="space-y-1">
          <h3 id={titleId} className="text-lg font-semibold text-slate-900">{title}</h3>
          {description ? <p id={descriptionId} className="text-sm text-slate-500">{description}</p> : null}
        </div>
        <div className="mt-4 space-y-4">
          {children}
          {footer ? <div className="flex justify-end gap-2">{footer}</div> : null}
        </div>
      </div>
    </div>
  );
}
