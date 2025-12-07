/**
 * Parse flexible date range formats into days.
 * Supported formats:
 *  - "3d" = 3 days
 *  - "2w" = 2 weeks (14 days)
 *  - "1m" = 1 month (30 days)
 *  - "1y" = 1 year (365 days)
 *  - "14" = 14 days (plain number)
 */

const DAYS_PER_WEEK = 7;
const DAYS_PER_MONTH = 30;
const DAYS_PER_YEAR = 365;

export interface ParsedDateRange {
  days: number;
  original: string;
}

export function parseDateRange(input: string): ParsedDateRange {
  const trimmed = input.trim();

  if (!trimmed) {
    throw new Error("Date range cannot be empty");
  }

  // Try to parse as plain number first
  const plainNumber = Number(trimmed);
  if (!Number.isNaN(plainNumber) && plainNumber > 0) {
    return {
      days: Math.floor(plainNumber),
      original: trimmed,
    };
  }

  // Parse format like "2w", "3d", "1m", "2y"
  const match = trimmed.match(/^(\d+)\s*([dwmy])$/i);

  if (!match) {
    throw new Error(
      `Invalid date range format: "${trimmed}". ` +
      `Valid formats: "3d" (days), "2w" (weeks), "1m" (months), "2y" (years), or plain number like "14"`
    );
  }

  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  if (amount <= 0) {
    throw new Error(`Date range amount must be positive, got: ${amount}`);
  }

  let days: number;
  switch (unit) {
    case "d":
      days = amount;
      break;
    case "w":
      days = amount * DAYS_PER_WEEK;
      break;
    case "m":
      days = amount * DAYS_PER_MONTH;
      break;
    case "y":
      days = amount * DAYS_PER_YEAR;
      break;
    default:
      throw new Error(`Unknown time unit: ${unit}`);
  }

  return {
    days,
    original: trimmed,
  };
}

/**
 * Format days back into a human-readable string.
 */
export function formatDaysAsRange(days: number): string {
  if (days < DAYS_PER_WEEK) {
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (days < DAYS_PER_MONTH) {
    const weeks = Math.floor(days / DAYS_PER_WEEK);
    const remainingDays = days % DAYS_PER_WEEK;
    if (remainingDays === 0) {
      return `${weeks} week${weeks === 1 ? "" : "s"}`;
    }
    return `${weeks} week${weeks === 1 ? "" : "s"} and ${remainingDays} day${remainingDays === 1 ? "" : "s"}`;
  }
  if (days < DAYS_PER_YEAR) {
    const months = Math.floor(days / DAYS_PER_MONTH);
    const remainingDays = days % DAYS_PER_MONTH;
    if (remainingDays === 0) {
      return `${months} month${months === 1 ? "" : "s"}`;
    }
    return `${months} month${months === 1 ? "" : "s"} and ${remainingDays} day${remainingDays === 1 ? "" : "s"}`;
  }
  const years = Math.floor(days / DAYS_PER_YEAR);
  const remainingDays = days % DAYS_PER_YEAR;
  if (remainingDays === 0) {
    return `${years} year${years === 1 ? "" : "s"}`;
  }
  return `${years} year${years === 1 ? "" : "s"} and ${remainingDays} day${remainingDays === 1 ? "" : "s"}`;
}
