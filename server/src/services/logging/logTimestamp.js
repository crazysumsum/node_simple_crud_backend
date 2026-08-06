const formatters = new Map();

function formatterFor(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(
      timeZone,
      new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
        timeZoneName: "longOffset"
      })
    );
  }

  return formatters.get(timeZone);
}

export function formatLogTimestamp(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error("Logger entry timestamp must be a valid date");
  }

  const parts = Object.fromEntries(
    formatterFor(timeZone)
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
