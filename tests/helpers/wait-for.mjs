// Polls until `check` returns a truthy value (returned) or `timeoutMs` passes (throws with `message`).
// For effects that finish on their own schedule, such as a run's history written after its process
// closed: a fixed sleep is too short on a slow CI disk (each write is fsynced).
export async function waitFor(check, { timeoutMs = 5000, intervalMs = 10, message = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${message}${lastError ? `: ${lastError.message}` : ''}`);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
