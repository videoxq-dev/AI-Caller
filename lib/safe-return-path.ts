export function safeReturnPath(value: string | null | undefined, fallback: string) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return fallback;
  return value;
}
