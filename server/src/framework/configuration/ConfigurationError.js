export class ConfigurationError extends Error {
  constructor(details) {
    const messages = details.map(({ section, message }) => `${section}: ${message}`);

    super(`Application configuration is invalid:\n- ${messages.join("\n- ")}`);
    this.name = "ConfigurationError";
    this.code = "CONFIGURATION_INVALID";
    this.details = details;
  }
}
