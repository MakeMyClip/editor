import { useEffect, useRef } from 'react';

interface ShortcutHandlers {
  onUndo?: () => void;
  onSnapshot?: () => void;
  onEscape?: () => void;
  onNewOp?: () => void;
}

/**
 * Global keyboard shortcuts:
 *   - ⌘/Ctrl + Z         — undo
 *   - ⌘/Ctrl + S         — snapshot (we intercept the browser's "save page"
 *                          since the page itself has nothing to save)
 *   - ⌘/Ctrl + Shift + N — new op picker
 *   - Esc                — close picker / cancel active form
 *
 * Shortcuts are suppressed while focus is in a text input / textarea so
 * typing ⌘Z in the middle of a caption still triggers the platform undo.
 *
 * The keydown listener is attached once; we read the latest handlers from
 * a ref so callers can pass fresh closures every render without thrashing
 * window.addEventListener.
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isEditable =
        tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable;

      const mod = e.metaKey || e.ctrlKey;
      const h = handlersRef.current;

      // Esc passes through even from inputs — it's the conventional cancel.
      if (e.key === 'Escape' && h.onEscape) {
        h.onEscape();
        return;
      }

      if (isEditable) return;

      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey && h.onUndo) {
        e.preventDefault();
        h.onUndo();
        return;
      }
      if (mod && e.key.toLowerCase() === 's' && !e.shiftKey && h.onSnapshot) {
        e.preventDefault();
        h.onSnapshot();
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'n' && h.onNewOp) {
        e.preventDefault();
        h.onNewOp();
        return;
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
