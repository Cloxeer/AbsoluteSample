export interface ToastAction {
  label: string;
  onAction: () => void;
}

export interface ToastMessage {
  id: string;
  message: string;
  action?: ToastAction;
}

type Listener = () => void;

const AUTO_DISMISS_MS = 8000;

/**
 * Small module-level pub-sub store for toast notifications, driven with useSyncExternalStore.
 * Toasts auto-dismiss after AUTO_DISMISS_MS unless dismissed earlier (e.g. via their action).
 */
class ToastStore {
  private toasts: ToastMessage[] = [];
  private listeners = new Set<Listener>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  getSnapshot = (): ToastMessage[] => {
    return this.toasts;
  };

  private emit() {
    for (const listener of this.listeners) listener();
  }

  publish(message: string, action?: ToastAction): string {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.toasts = [...this.toasts, { id, message, action }];
    this.emit();
    const timer = setTimeout(() => this.dismiss(id), AUTO_DISMISS_MS);
    this.timers.set(id, timer);
    return id;
  }

  dismiss(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    if (!this.toasts.some((t) => t.id === id)) return;
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.emit();
  }
}

export const toastStore = new ToastStore();
