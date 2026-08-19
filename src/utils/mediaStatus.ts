/**
 * Media status vocabulary for Overseerr/Jellyseerr.
 *
 * Status codes returned by the Seerr API:
 *   1 = UNKNOWN
 *   2 = PENDING       — request submitted, waiting to be picked up
 *   3 = PROCESSING    — Radarr/Sonarr is actively grabbing it
 *   4 = PARTIALLY_AVAILABLE — some episodes present, more coming
 *   5 = AVAILABLE     — fully in the library
 *   6 = DELETED
 */
export const MEDIA_STATUS: Record<number, string> = {
  1: 'UNKNOWN',
  2: 'PENDING',
  3: 'PROCESSING',
  4: 'PARTIALLY_AVAILABLE',
  5: 'AVAILABLE',
  6: 'DELETED',
};

/**
 * Returns true when media is tracked by the system —
 * i.e. has been requested or is in the library in any state.
 * Statuses 2–5 all count; 1 (UNKNOWN) and 6 (DELETED) do not.
 */
export function isTracked(status: number): boolean {
  return [2, 3, 4, 5].includes(status);
}

/**
 * Returns true only when media is fully available in the library (status 5).
 */
export function isFullyAvailable(status: number): boolean {
  return status === 5;
}

/**
 * Maps a numeric status code to its string label.
 * Returns 'UNKNOWN' for unrecognised codes.
 */
export function label(status: number): string {
  return MEDIA_STATUS[status] ?? 'UNKNOWN';
}
