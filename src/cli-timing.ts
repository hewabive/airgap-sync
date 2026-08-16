const secondMs = 1_000;
const minuteSeconds = 60;
const hourSeconds = 60 * minuteSeconds;

export function formatElapsedTime(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / secondMs));
  const hours = Math.floor(totalSeconds / hourSeconds);
  const minutes = Math.floor((totalSeconds % hourSeconds) / minuteSeconds);
  const seconds = totalSeconds % minuteSeconds;

  return `${String(hours)}h ${String(minutes)}m ${String(seconds)}s`;
}
