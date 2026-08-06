import { ApplicationError } from "../errors/ApplicationError.js";

export class AuthenticationError extends ApplicationError {
  constructor(code, message, statusCode = 401) {
    super(message, {
      code,
      statusCode,
      publicCode: "Unauthorized Access",
      publicMessage: "Unauthorized Access"
    });
  }
}
