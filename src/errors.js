// Errors whose message was written by fundkit itself (no remote free text, no secrets).
// Only these messages are ever shown in chat, logs, state history or the signing page.
export class SafeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function safeError(err) {
  if (err instanceof SafeError) return err.message;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'request timed out';
  return 'network or internal error';
}
