export class HttpError extends Error {
  readonly status: number;
  readonly reason?: string;

  constructor(message: string, status: number, reason?: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.reason = reason;
  }
}
