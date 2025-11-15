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

/**
 * Infers the expected media type based on title patterns
 * Returns 'tv' if title contains season indicators, otherwise 'any'
 */
export function inferExpectedMediaType(originalTitle: string): 'tv' | 'movie' | 'any' {
  // If title has season indicators, expect TV show
  if (isSequelTitle(originalTitle) || extractSeasonNumber(originalTitle) !== null) {
    return 'tv';
  }
  // Default to any (no preference)
  return 'any';
}

/**
 * Selects the best match from search results with confidence scoring
 * Prioritizes matches that align with expected media type
 */
export function selectBestMatch(
  results: any[],
  expectedType: 'tv' | 'movie' | 'any',
  searchTitle: string
): { match: any; confidence: 'high' | 'medium' | 'low' } {
  if (!results || results.length === 0) {
    throw new Error('No results to select from');
  }

  // 1. Filter by expected type if specified
  if (expectedType !== 'any') {
    const typeFiltered = results.filter(r => r.mediaType === expectedType);
    
    // If we have type-filtered results, use first one with high confidence
    if (typeFiltered.length > 0) {
      return { match: typeFiltered[0], confidence: 'high' };
    }
  }

  // 2. Fallback: Check if first result title closely matches search
  const firstResult = results[0];
  const firstResultTitle = (firstResult.title || firstResult.name || '').toLowerCase();
  const normalizedSearch = searchTitle.toLowerCase();
  
  // Simple similarity check - exact substring match or very similar
  const titleSimilarity = calculateSimilarity(normalizedSearch, firstResultTitle);
  
  if (titleSimilarity > 0.8) {
    return { match: firstResult, confidence: 'medium' };
  }

  // 3. Low confidence - might be wrong match
  return { match: firstResult, confidence: 'low' };
}

/**
 * Calculate simple similarity score between two strings
 * Returns value between 0 and 1
 */
function calculateSimilarity(str1: string, str2: string): number {
  // Exact match
  if (str1 === str2) return 1.0;
  
  // Check if one contains the other
  if (str1.includes(str2) || str2.includes(str1)) {
    return 0.9;
  }
  
  // Simple word overlap scoring
  const words1 = str1.split(/\s+/).filter(w => w.length > 2);
  const words2 = str2.split(/\s+/).filter(w => w.length > 2);
  
  if (words1.length === 0 || words2.length === 0) return 0;
  
  const commonWords = words1.filter(w => words2.includes(w));
  const similarity = (commonWords.length * 2) / (words1.length + words2.length);
  
  return similarity;
}

/**
 * Enhanced URL encoding for search queries
 * Handles special characters that cause issues with Overseerr/TMDB API
 */
export function encodeSearchQuery(query: string): string {
  // Start with standard encoding
  let encoded = encodeURIComponent(query);
  
  // Manually encode characters that cause issues with Overseerr/TMDB API
  // Based on RFC 3986 and observed failures
  const additionalEncoding: Record<string, string> = {
    '!': '%21',  // Exclamation - causes 400 errors
    "'": '%27',  // Apostrophe - causes 400 errors
    '(': '%28',  // Parentheses
    ')': '%29',
    '*': '%2A',  // Asterisk
  };
  
  for (const [char, encodedChar] of Object.entries(additionalEncoding)) {
    encoded = encoded.replace(new RegExp('\\' + char, 'g'), encodedChar);
  }
  
  return encoded;
}