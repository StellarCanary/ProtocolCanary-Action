export class CanaryActionError extends Error {
  constructor(
    public readonly code: string,
    public readonly message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

// Removed ArtifactUploadFailedError - upload failures are handled via return values
// in uploadReport() rather than exceptions.