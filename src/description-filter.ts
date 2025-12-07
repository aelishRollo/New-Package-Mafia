/**
 * Filter utilities for searching package descriptions.
 */

export interface SearchOptions {
  /** Search terms to look for (AND logic) */
  terms: string[];
  /** Whether to match partial words (default: true) */
  partialMatch?: boolean;
  /** Case insensitive matching (default: true) */
  caseInsensitive?: boolean;
}

/**
 * Parse search string into individual terms.
 * Splits on whitespace and filters out empty strings.
 */
export function parseSearchTerms(searchString: string): string[] {
  return searchString
    .trim()
    .split(/\s+/)
    .filter((term) => term.length > 0);
}

/**
 * Check if a description matches the search criteria.
 * All terms must be present (AND logic).
 */
export function matchesSearch(
  description: string,
  options: SearchOptions
): boolean {
  const { terms, partialMatch = true, caseInsensitive = true } = options;

  // If no terms, everything matches
  if (terms.length === 0) {
    return true;
  }

  // If description is empty and we have search terms, no match
  if (!description || description.trim().length === 0) {
    return false;
  }

  const searchableDescription = caseInsensitive
    ? description.toLowerCase()
    : description;

  // All terms must match (AND logic)
  return terms.every((term) => {
    const searchTerm = caseInsensitive ? term.toLowerCase() : term;

    if (partialMatch) {
      return searchableDescription.includes(searchTerm);
    } else {
      // Match whole words only
      const wordBoundaryRegex = new RegExp(
        `\\b${escapeRegex(searchTerm)}\\b`,
        caseInsensitive ? "i" : ""
      );
      return wordBoundaryRegex.test(description);
    }
  });
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
