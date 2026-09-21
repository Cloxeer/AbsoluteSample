const STORAGE_KEY = "absolutesample.lowPriority";

/** Reads the persisted "run engine at low priority" preference. Defaults to false. */
export function getLowPriority(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/** Persists the "run engine at low priority" preference. */
export function setLowPriority(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, value ? "true" : "false");
  } catch {
    // ignore (e.g. private browsing / storage disabled)
  }
}
