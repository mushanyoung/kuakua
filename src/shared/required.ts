// Check invariants at runtime as well as under TypeScript's strict null checks.
export function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Required value is missing");
  return value;
}
