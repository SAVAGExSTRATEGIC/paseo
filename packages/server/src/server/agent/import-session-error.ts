export type ImportSessionErrorKind = "timeout" | "scan_limit" | "pagination_stalled";

export class ImportSessionListingError extends Error {
  constructor(
    readonly kind: ImportSessionErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ImportSessionListingError";
  }
}

export function getImportSessionErrorKind(error: unknown): ImportSessionErrorKind | undefined {
  if (error instanceof ImportSessionListingError) return error.kind;
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  return undefined;
}
