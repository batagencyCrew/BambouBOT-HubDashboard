export function JsonBlock({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return <pre className="code-block">{text}</pre>;
}

export function isEmptyJson(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}
