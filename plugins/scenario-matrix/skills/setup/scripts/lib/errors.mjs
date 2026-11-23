// A setup step stops with a typed error so setup.mjs can map it to an exit code.
export class SetupError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}
