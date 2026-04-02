export function nowIso(): string {
  return new Date().toISOString();
}

export function isDue(date: string | null, reference = new Date()): boolean {
  if (!date) {
    return true;
  }
  return new Date(date).getTime() <= reference.getTime();
}

export function addDays(date: Date, days: number): string {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next.toISOString();
}

export function formatRelativeDate(date: string | null): string {
  if (!date) {
    return "Now";
  }
  const target = new Date(date);
  if (Number.isNaN(target.getTime())) {
    return "Unknown";
  }
  return target.toLocaleString();
}

export function formatThreadDate(date: string | null): string {
  if (!date) {
    return "Now";
  }

  const target = new Date(date);
  if (Number.isNaN(target.getTime())) {
    return "Unknown";
  }

  const now = new Date();
  const isSameDay =
    target.getFullYear() === now.getFullYear() &&
    target.getMonth() === now.getMonth() &&
    target.getDate() === now.getDate();

  if (isSameDay) {
    return target.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  if (target.getFullYear() === now.getFullYear()) {
    return target.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  return target.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}
