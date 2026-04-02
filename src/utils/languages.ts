const LANGUAGE_ALIASES: Record<string, string> = {
  en: "English",
  eng: "English",
  english: "English",
  es: "Spanish",
  spa: "Spanish",
  spanish: "Spanish",
  fr: "French",
  fre: "French",
  fra: "French",
  french: "French",
  de: "German",
  deu: "German",
  ger: "German",
  german: "German",
  it: "Italian",
  ita: "Italian",
  italian: "Italian",
  pt: "Portuguese",
  por: "Portuguese",
  portuguese: "Portuguese",
  zh: "Chinese",
  zho: "Chinese",
  chi: "Chinese",
  chinese: "Chinese",
  ja: "Japanese",
  jpn: "Japanese",
  japanese: "Japanese",
  ko: "Korean",
  kor: "Korean",
  korean: "Korean",
  ru: "Russian",
  rus: "Russian",
  russian: "Russian",
  ar: "Arabic",
  ara: "Arabic",
  arabic: "Arabic",
  unknown: "Unknown",
  auto: "Unknown"
};

export function canonicalizeLanguage(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Unknown";
  }

  const normalized = trimmed.toLowerCase().replace(/[_-]+/g, " ");
  if (LANGUAGE_ALIASES[normalized]) {
    return LANGUAGE_ALIASES[normalized];
  }

  return normalized
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
