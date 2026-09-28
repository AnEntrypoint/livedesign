export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
