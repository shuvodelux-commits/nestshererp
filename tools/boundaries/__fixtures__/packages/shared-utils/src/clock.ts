// FIXTURE — the one file allowed to read the wall clock. Must produce NO violation.
export function now(): Date {
  return new Date();
}
