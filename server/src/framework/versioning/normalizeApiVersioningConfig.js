export function normalizeApiVersioningConfig(source) {
  const defaultVersion = String(source?.defaultVersion || "").trim();
  const supportedVersions = Array.isArray(source?.supportedVersions)
    ? source.supportedVersions.map((value) => String(value).trim()).filter(Boolean)
    : [];
  const responseHeaderName = String(source?.responseHeaderName || "").trim();

  if (!/^v[1-9]\d*$/.test(defaultVersion)) {
    throw new Error('API versioning config "defaultVersion" must match v<number>');
  }

  if (
    supportedVersions.length === 0 ||
    new Set(supportedVersions).size !== supportedVersions.length ||
    supportedVersions.some((version) => !/^v[1-9]\d*$/.test(version))
  ) {
    throw new Error(
      'API versioning config "supportedVersions" must contain unique v<number> values'
    );
  }

  if (!supportedVersions.includes(defaultVersion)) {
    throw new Error("API versioning defaultVersion must be supported");
  }

  if (!/^[A-Za-z0-9-]+$/.test(responseHeaderName)) {
    throw new Error('API versioning config "responseHeaderName" is invalid');
  }

  return Object.freeze({
    enabled: source?.enabled !== false,
    defaultVersion,
    supportedVersions: Object.freeze(supportedVersions),
    responseHeaderName
  });
}
