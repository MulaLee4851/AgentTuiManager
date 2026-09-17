/** Disable decorative composer effects for every Manager-owned Codex launch.
 * Keep normal animations and the user's global config untouched. Put the
 * override at the end of the root options, before resume or --. Codex resume
 * can replace root -c overrides when a -c is supplied after the subcommand.
 */
export function codexTerminalCompatibilityArgs(args: string[]): string[] {
  const separator = args.indexOf('--')
  const rootEnd = separator < 0 ? args.length : separator
  const resume = args.indexOf('resume')
  const index = resume >= 0 && resume < rootEnd ? resume : rootEnd
  return [...args.slice(0, index), '-c', 'tui.whimsy=false', ...args.slice(index)]
}
