/** 3:07 — the player's clock. */
export function clockText(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  const rest = whole % 60;
  return `${Math.floor(whole / 60)}:${rest < 10 ? '0' : ''}${rest}`;
}

/** "2 min 5 s" — how long something has been waiting. */
export function secondsText(value: number): string {
  const whole = Math.max(0, Math.floor(value));
  const minutes = Math.floor(whole / 60);
  return minutes > 0 ? `${minutes} min ${whole % 60} s` : `${whole % 60} s`;
}

const UNITS = ['B', 'kB', 'MB', 'GB', 'TB'];

/** 1.2 GB — sizes in decimal units, as Crucible states them. */
export function bytesText(value: number | null): string | null {
  if (value === null) return null;
  let scaled = value;
  let unit = 0;
  while (scaled >= 1000 && unit < UNITS.length - 1) {
    scaled /= 1000;
    unit += 1;
  }
  return `${scaled.toFixed(unit === 0 ? 0 : scaled < 100 ? 1 : 0)} ${UNITS[unit]}`;
}
