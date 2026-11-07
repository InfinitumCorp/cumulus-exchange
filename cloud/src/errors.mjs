/** Operational HTTP error. `message` is safe to return to the caller. */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {Record<string, string>} [headers]
   */
  constructor(status, code, message, headers) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export function isHttpError(err) {
  return err instanceof HttpError;
}
