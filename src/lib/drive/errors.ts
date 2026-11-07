export class DriveError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.name = "DriveError";
    this.status = status;
    this.code = code;
  }
}
