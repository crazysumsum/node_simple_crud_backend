function optionalDate(value, key, routeKey) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`${key} must be a valid date for ${routeKey}`);
  }

  return date;
}

export function normalizeApiLifecycle(route, config, routeKey) {
  const version = String(route.version || "").trim();

  if (config.enabled) {
    if (!config.supportedVersions.includes(version)) {
      throw new Error(`Unsupported API version for ${routeKey}: ${version || "missing"}`);
    }

    if (!route.path.startsWith(`/api/${version}/`)) {
      throw new Error(`API path must start with /api/${version}/ for ${routeKey}`);
    }
  }

  const source = route.deprecation || {};
  const deprecated = source.deprecated === true;
  const deprecatedAt = optionalDate(source.deprecatedAt, "deprecatedAt", routeKey);
  const sunsetAt = optionalDate(source.sunsetAt, "sunsetAt", routeKey);
  const replacement = source.replacement
    ? String(source.replacement).trim()
    : null;

  if (!deprecated && (deprecatedAt || sunsetAt || replacement)) {
    throw new Error(`Deprecation metadata requires deprecated=true for ${routeKey}`);
  }

  if (deprecatedAt && sunsetAt && sunsetAt < deprecatedAt) {
    throw new Error(`sunsetAt cannot be earlier than deprecatedAt for ${routeKey}`);
  }

  if (replacement && !replacement.startsWith("/api/")) {
    throw new Error(`Deprecation replacement must start with /api/ for ${routeKey}`);
  }

  return Object.freeze({
    version: version || config.defaultVersion,
    deprecated,
    deprecatedAt: deprecatedAt?.toISOString() || null,
    sunsetAt: sunsetAt?.toISOString() || null,
    replacement
  });
}

export function createApiLifecycleMiddleware({ lifecycle, config, logger }) {
  return function apiLifecycle(req, res, next) {
    res.setHeader(config.responseHeaderName, lifecycle.version);

    if (lifecycle.deprecated) {
      const deprecationValue = lifecycle.deprecatedAt
        ? `@${Math.floor(new Date(lifecycle.deprecatedAt).getTime() / 1000)}`
        : "?1";
      res.setHeader("Deprecation", deprecationValue);

      if (lifecycle.sunsetAt) {
        res.setHeader("Sunset", new Date(lifecycle.sunsetAt).toUTCString());
      }

      if (lifecycle.replacement) {
        res.append("Link", `<${lifecycle.replacement}>; rel="successor-version"`);
      }

      void logger.warn("api.deprecated.called", "Deprecated API was called", {
        requestId: req.requestId || null,
        method: req.method,
        path: req.route?.path || req.path,
        version: lifecycle.version,
        sunsetAt: lifecycle.sunsetAt,
        replacement: lifecycle.replacement
      });
    }

    next();
  };
}
