/** Server authorization remains authoritative; unknown client rights are not denials. */
export function isPermissionDenied(value: boolean | undefined): boolean {
  return value === false;
}
