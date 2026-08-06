export class ApplicationError extends Error {
  constructor(
    message,
    {
      code = "INTERNAL_SERVER_ERROR",
      statusCode = 500,
      details,
      publicCode = code,
      publicMessage = message,
      publicDetails,
      cause
    } = {}
  ) {
    super(message, cause ? { cause } : undefined);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.publicCode = publicCode;
    this.publicMessage = publicMessage;
    this.publicDetails = publicDetails;
  }
}
