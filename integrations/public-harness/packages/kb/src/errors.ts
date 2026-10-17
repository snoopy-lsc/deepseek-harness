/** A refusal the socket server turns into a JSON reply; `extra` fields are safe to show (limit names and numbers, never content). */
export class KbError extends Error {
  readonly status: number
  readonly code: string
  readonly extra: Record<string, unknown>
  constructor(status: number, code: string, extra: Record<string, unknown> = {}) { super(code); this.status = status; this.code = code; this.extra = extra }
}
