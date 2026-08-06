import jwt from "jsonwebtoken";
import jwtConfig from "../../../config/jwt.js";
import { normalizeJwtConfig } from "../configuration/normalizeJwtConfig.js";

function activeJwtConfig(source = jwtConfig) {
  return normalizeJwtConfig(source, {
    environment: process.env.NODE_ENV || "development",
    environmentSecret: process.env.JWT_SECRET
  });
}

export function validateJwtConfig(config = jwtConfig) {
  return activeJwtConfig(config);
}

export function issueAccessToken(payload, { subject, config = jwtConfig } = {}) {
  const activeConfig = activeJwtConfig(config);

  const options = {
    algorithm: activeConfig.algorithm,
    expiresIn: activeConfig.expiresIn,
    issuer: activeConfig.issuer,
    audience: activeConfig.audience
  };

  if (subject !== undefined && subject !== null) {
    options.subject = String(subject);
  }

  return jwt.sign(payload, activeConfig.secret, options);
}

export function verifyAccessToken(token, { config = jwtConfig } = {}) {
  const activeConfig = activeJwtConfig(config);

  return jwt.verify(token, activeConfig.secret, {
    algorithms: [activeConfig.algorithm],
    issuer: activeConfig.issuer,
    audience: activeConfig.audience,
    clockTolerance: activeConfig.clockToleranceSeconds
  });
}
