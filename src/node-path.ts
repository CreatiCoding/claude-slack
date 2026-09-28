/**
 * The node the hooks and the channel shim are started with.
 *
 * `process.execPath` under Homebrew is `<prefix>/Cellar/<formula>/<version>/bin/node`, and `brew upgrade`
 * deletes that version's folder. Every hook and the Slack channel would then fail to start, silently.
 * `<prefix>/opt/<formula>` is a symlink Homebrew moves to the new version, so it survives upgrades.
 */
import { existsSync, realpathSync } from 'node:fs'

export function stableNodePath(
  execPath = process.execPath,
  exists: (p: string) => boolean = existsSync,
  real: (p: string) => string = realpathSync,
): string {
  const m = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(execPath)
  if (!m) return execPath
  const stable = `${m[1]}/opt/${m[2]}/bin/node`
  try {
    // Only when it really is this same node today; otherwise keep the exact path.
    return exists(stable) && real(stable) === real(execPath) ? stable : execPath
  } catch {
    return execPath
  }
}
