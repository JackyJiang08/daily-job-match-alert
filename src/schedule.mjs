// The nightly run's default local time. The installed LaunchAgent (scripts/install-launchd.sh [hour] [minute])
// is the source of truth: the dispatcher reads its hour and minute from the plist's environment and the hub
// reads them from the plist itself; this default applies only when neither is there.
export const DEFAULT_SCHEDULE = Object.freeze({ hour: 18, minute: 0 });

// "18:00"
export function scheduleClock({ hour, minute } = DEFAULT_SCHEDULE) {
  return `${String(Number(hour)).padStart(2, '0')}:${String(Number(minute)).padStart(2, '0')}`;
}
