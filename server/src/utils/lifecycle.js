let shuttingDown = false;

/**
 * Process lifecycle state, kept in one tiny module so the readiness endpoint can
 * see it without importing src/index.js (which would create a cycle: index ->
 * app -> routes -> controller -> index).
 */
export function markShuttingDown() {
  shuttingDown = true;
}

export function isShuttingDown() {
  return shuttingDown;
}
