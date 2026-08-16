// DELIBERATE VIOLATION FIXTURE — never copy this into a real package.
export function stamp(): number {
  const at = new Date();
  return Date.now() + at.getTime();
}
