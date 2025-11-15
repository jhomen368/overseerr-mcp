/**
 * Normalizes a title by removing season indicators while preserving integral numbers
 * Examples:
 *   "My Hero Academia Season 7" → "My Hero Academia"
 *   "Demon Slayer: Kimetsu no Yaiba S4" → "Demon Slayer: Kimetsu no Yaiba"
 *   "Mob Psycho 100" → "Mob Psycho 100" (preserves integral number)
 *   "Mob Psycho 100 III" → "Mob Psycho 100" (removes Roman numeral season)
 */
export function normalizeTitle(title: string): string {
  let normalized = title;

  // Remove Roman numeral seasons at the end (I, II, III, IV, V, etc.)
  // Must be preceded by space and at end or before parentheses
  normalized = normalized.replace(/\s+(?:I|II|III|IV|V|VI|VII|VIII|IX|X|XI|XII|XIII|XIV|XV)(?:\s*\(|$)/gi, '');

  // Remove patterns like "Season N", "Season N/Part N", etc.
  const seasonPatterns = [
    /\s*[-:]\s*Season\s+\d+/gi,
    /\s*Season\s+\d+/gi,
    /\s*S\s*\d+/gi,
    /\s*Part\s+\d+/gi,
    /\s*Cour\s+\d+/gi,
    /\s*\d+(?:st|nd|rd|th)\s+Season/gi,
    /\s*Final\s+Season/gi,
    /\s*The\s+Final\s+Season/gi,
    /\s*\(Season\s+\d+\)/gi,
    /\s*\(\d+(?:st|nd|rd|th)\s+Season\)/gi,
  ];

  for (const pattern of seasonPatterns) {
    normalized = normalized.replace(pattern, '');
  }

  // Remove year in parentheses at the end: (2024), (2023), etc.
  normalized = normalized.replace(/\s*\(\d{4}\)\s*$/g, '');

  // Clean up extra whitespace
  normalized = normalized.replace(/\s+/g, ' ').trim();

  return normalized;
}

/**
 * Extracts season number from a title if present
 * Returns null if no season indicator found
 * Supports numeric (Season 7, S7) and Roman numeral (III, IV) formats
 */
export function extractSeasonNumber(title: string): number | null {
  // Roman numeral mapping
  const romanToNumber: Record<string, number> = {
    'I': 1, 'II': 2, 'III': 3, 'IV': 4, 'V': 5,
    'VI': 6, 'VII': 7, 'VIII': 8, 'IX': 9, 'X': 10,
    'XI': 11, 'XII': 12, 'XIII': 13, 'XIV': 14, 'XV': 15
  };

  // Check for Roman numerals at the end (preceded by space)
  const romanMatch = title.match(/\s+(I|II|III|IV|V|VI|VII|VIII|IX|X|XI|XII|XIII|XIV|XV)(?:\s*\(|$)/i);
  if (romanMatch && romanMatch[1]) {
    const roman = romanMatch[1].toUpperCase();
    return romanToNumber[roman] || null;
  }

  // Match patterns like "Season 7", "S7", "Season VII", etc.
  const seasonMatches = [
    /Season\s+(\d+)/i,
    /\bS\s*(\d+)/i,
    /Part\s+(\d+)/i,
    /Cour\s+(\d+)/i,
    /(\d+)(?:st|nd|rd|th)\s+Season/i,
  ];

  for (const pattern of seasonMatches) {
    const match = title.match(pattern);
    if (match && match[1]) {
      return parseInt(match[1], 10);
    }
  }

  return null;
}

/**
 * Checks if a title appears to be a sequel/continuation
 */
export function isSequelTitle(title: string): boolean {
  const patterns = [
    /Season\s+[2-9]/i,
    /\bS\s*[2-9]/i,
    /Part\s+[2-9]/i,
    /\b(?:2nd|3rd|4th|5th|6th|7th|8th|9th)\s+Season/i,
    /Final\s+Season/i,
    /\s+(?:II|III|IV|V|VI|VII|VIII|IX|X|XI|XII|XIII|XIV|XV)(?:\s*\(|$)/i, // Roman numerals
  ];

  return patterns.some(pattern => pattern.test(title));
}