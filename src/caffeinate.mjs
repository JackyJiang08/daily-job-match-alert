// Keeps the Mac awake while a pipeline run is in flight: on macOS the run is started under
// `caffeinate -i` (no idle sleep until the child exits; caffeinate returns the child's exit code).
// Elsewhere the command is returned unchanged. Closing the lid on battery still sleeps the Mac;
// collectAtsBoards' outage handling covers that case.
export const CAFFEINATE = '/usr/bin/caffeinate';

export function caffeinated(command, args = [], { platform = process.platform } = {}) {
  if (platform !== 'darwin') return { command, args: [...args], caffeinated: false };
  return { command: CAFFEINATE, args: ['-i', command, ...args], caffeinated: true };
}
