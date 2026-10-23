/** Mirror pipeline errors; `message` is the wire / HTTP conflict code. */

export type MirrorErrorCode =
  | 'integrity'
  | 'closure-source'
  | 'artifact-mismatch'
  | 'ready-frozen'
  | 'blob-immutable'
  | 'artifact-too-large'
  | 'package'
  | 'scope'
  | 'tarball-host'
  | 'upload'

/** A refused mirror step; `message` is the stable error code. */
export class MirrorError extends Error {
  readonly detail: string | undefined
  constructor(code: MirrorErrorCode, detail?: string) {
    super(code)
    this.detail = detail
  }
}
