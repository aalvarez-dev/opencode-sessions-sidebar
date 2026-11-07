/** Only the visible onboarding-close click is accepted by the isolated Mac design relay. */
export function parseDesignClick(input: unknown, columns: number, rows: number, lastId: number) {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("Design input must be an object.");
  const request = input as Record<string, unknown>;
  const fields = ["id", "type", "column", "row"];
  if (Object.keys(request).length !== fields.length || fields.some((field) => !(field in request)))
    throw new TypeError("Unexpected design input fields.");
  if (
    !Number.isSafeInteger(request.id) ||
    (request.id as number) <= lastId ||
    request.type !== "close-native-onboarding" ||
    !Number.isSafeInteger(request.column) ||
    !Number.isSafeInteger(request.row) ||
    (request.column as number) < 1 ||
    (request.column as number) > columns ||
    (request.row as number) < 1 ||
    (request.row as number) > rows
  )
    throw new RangeError("Design click is stale, unsupported, or outside the actual terminal.");
  return {
    id: request.id as number,
    column: request.column as number,
    row: request.row as number,
  };
}
