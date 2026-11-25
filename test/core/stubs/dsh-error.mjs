/**
 * TEST STUB for '@deepseek-ai/dsh-error', byte-faithful to the installed
 * source (0.2.2-rc.5, dsh-error/src/index.ts L13-22, read 2026-11-25):
 * HarnessError extends Error, constructor(message, code, options?),
 * readonly code, name = new.target.name. Lets plain `node --test` load
 * src/core/errors.js (the REAL ScixError subclass) without the DSH runtime.
 */
export class HarnessError extends Error {
  constructor(message, code, options) {
    super(message, options)
    this.code = code
    this.name = new.target.name
  }
}
