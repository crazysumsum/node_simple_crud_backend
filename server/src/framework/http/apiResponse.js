function responseMeta(res, additionalMeta = {}) {
  return {
    requestId:
      res.req?.requestId || res.getHeader?.("x-request-id") || null,
    timestamp: new Date().toISOString(),
    ...additionalMeta
  };
}

export function sendSuccess(
  res,
  data,
  { statusCode = 200, meta = {} } = {}
) {
  return res.status(statusCode).json({
    success: true,
    data: data ?? null,
    meta: responseMeta(res, meta)
  });
}

export function sendError(
  res,
  {
    statusCode = 500,
    code = "INTERNAL_SERVER_ERROR",
    message = "Internal server error",
    details,
    meta = {}
  } = {}
) {
  const error = { code, message };

  if (details !== undefined) {
    error.details = details;
  }

  return res.status(statusCode).json({
    success: false,
    error,
    meta: responseMeta(res, meta)
  });
}
