/** Shared refusal type for authenticated personal and administrator account requests. */
export class MeError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}
