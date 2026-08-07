const formatters = new Map();

function formatterFor(timeZone, options) {
  const key = `${timeZone}:${JSON.stringify(options)}`;

  if (!formatters.has(key)) {
    formatters.set(key, new Intl.DateTimeFormat("en-CA", { timeZone, ...options }));
  }

  return formatters.get(key);
}

export function asValidDate(value, fieldName = "Time value") {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be a valid date`);
  }

  return date;
}

export function formatTimestamp(value, timeZone) {
  const date = asValidDate(value);
  const parts = Object.fromEntries(
    formatterFor(timeZone, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset"
    })
      .formatToParts(date)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value: partValue }) => [type, partValue])
  );
  const offset = parts.timeZoneName === "GMT"
    ? "Z"
    : parts.timeZoneName.replace("GMT", "");
  const milliseconds = String(date.getUTCMilliseconds()).padStart(3, "0");

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${milliseconds}${offset}`;
}

export function formatDateForFile(value, timeZone) {
  const parts = Object.fromEntries(
    formatterFor(timeZone, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    })
      .formatToParts(asValidDate(value))
      .filter(({ type }) => type !== "literal")
      .map(({ type, value: partValue }) => [type, partValue])
  );

  return `${parts.year}-${parts.month}-${parts.day}`;
}
