export function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function normalizeExpression(value: string): string {
  return value
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]+/gu, " ")
    .replace(/\s+/g, " ");
}

export function slugify(value: string): string {
  const slug = normalizeExpression(value)
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "item";
}

export function titleFromText(value: string, maxLength = 48): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxLength) {
    return trimmed || "New Thread";
  }
  return `${trimmed.slice(0, maxLength - 1).trim()}…`;
}

export function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

export function toSentenceCase(value: string): string {
  if (!value) {
    return value;
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function capitalizeLabel(value: string): string {
  if (!value) {
    return value;
  }

  return value.replace(/^(\s*["'“”`([{<]*)?(\p{Ll})/u, (_match, prefix = "", first) => {
    return `${prefix}${String(first).toUpperCase()}`;
  });
}
