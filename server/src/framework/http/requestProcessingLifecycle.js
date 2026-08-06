const REQUEST_PROCESSING = Symbol("requestProcessingLifecycle");

function lifecycleFor(req) {
  if (!req[REQUEST_PROCESSING]) {
    req[REQUEST_PROCESSING] = {
      started: false,
      completed: false,
      listeners: new Set()
    };
  }

  return req[REQUEST_PROCESSING];
}

export function onRequestProcessingComplete(req, listener) {
  if (typeof listener !== "function") {
    throw new TypeError("Request processing completion listener must be a function");
  }

  const lifecycle = lifecycleFor(req);

  if (lifecycle.completed) {
    listener();
    return () => {};
  }

  lifecycle.listeners.add(listener);
  return () => lifecycle.listeners.delete(listener);
}

export function markRequestProcessingStarted(req) {
  const lifecycle = lifecycleFor(req);

  if (!lifecycle.completed) {
    lifecycle.started = true;
  }
}

export function markRequestProcessingCompleted(req) {
  const lifecycle = lifecycleFor(req);

  if (lifecycle.completed) {
    return;
  }

  lifecycle.completed = true;

  for (const listener of lifecycle.listeners) {
    listener();
  }

  lifecycle.listeners.clear();
}

export function markRequestResponseEnded(req) {
  const lifecycle = lifecycleFor(req);

  // Requests that reached a Handler are completed by the dispatcher, even when
  // a timeout or client disconnect ends the HTTP response first.
  if (!lifecycle.started) {
    markRequestProcessingCompleted(req);
  }
}
