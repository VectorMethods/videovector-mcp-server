/** Browser read suppression only. This never grants or renews server capacity. */
export const PASSIVE_API_IDLE_MS = 30 * 60 * 1000;

// Standalone presentation consumers (MCP) have no AppContent activity owner.
// They still obey route/document visibility but do not invent an idle lease.
let activeUntil = Number.POSITIVE_INFINITY;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

const scheduleExpiry = () => {
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  expiryTimer = null;
  if (!listeners.size || !Number.isFinite(activeUntil) || activeUntil <= Date.now()) return;
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    listeners.forEach((listener) => listener());
  }, activeUntil - Date.now());
};

// Called only by the existing AppContent genuine-activity observer, never by
// a request, token refresh, stream event, poll, or timer.
export const recordPassiveApiActivity = (): void => {
  activeUntil = Date.now() + PASSIVE_API_IDLE_MS;
  scheduleExpiry();
  listeners.forEach((listener) => listener());
};

export const clearPassiveApiActivity = (): void => {
  activeUntil = 0;
  scheduleExpiry();
  listeners.forEach((listener) => listener());
};

export const isPassiveApiActivityRecent = (): boolean => Date.now() < activeUntil;

export const subscribePassiveApiActivity = (listener: () => void): (() => void) => {
  listeners.add(listener);
  scheduleExpiry();
  return () => { listeners.delete(listener); scheduleExpiry(); };
};
