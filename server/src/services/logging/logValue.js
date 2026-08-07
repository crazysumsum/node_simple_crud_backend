// Converts arbitrary log values into safe JSON-compatible values.
export function redactValue(
  value,
  sensitiveFields,
  formatDate,
  seen = new WeakSet(),
  depth = 0
) {
  if (value === null || value === undefined) {
    return value ?? null;
  }

  if (["string", "number", "boolean"].includes(typeof value)) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Buffer.isBuffer(value)) {
    return `[Buffer ${value.length} bytes]`;
  }

  if (value instanceof Date) {
    return formatDate(value);
  }

  if (typeof value !== "object") {
    return String(value);
  }

  if (depth >= 10) {
    return "[MAX_DEPTH]";
  }

  if (seen.has(value)) {
    return "[CIRCULAR]";
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) =>
      redactValue(item, sensitiveFields, formatDate, seen, depth + 1)
    );
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sensitiveFields.has(key.toLowerCase())
        ? "[REDACTED]"
        : redactValue(item, sensitiveFields, formatDate, seen, depth + 1)
    ])
  );
}
