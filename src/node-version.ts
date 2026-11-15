/* The runtime check the entry file runs before it loads anything else (1.1.5). This module imports nothing, so it
 * loads on any Node.js that can parse an ES module, including the releases the server cannot run on. */

/** The line the server says at start on a Node.js it cannot run on, or null when the runtime is new enough
 *  (or cannot be read). `range` is package.json's engines.node; the one form read is `>=N` (`>=20`, `>=20.11.0`). */
export function nodeVersionProblem(nodeVersion: string, range: string): string | null {
  const minimum = /^\s*>=\s*(\d+)/.exec(range);
  if (!minimum) return null;
  const running = /^v?(\d+)/.exec(nodeVersion);
  if (!running) return null;
  const needed = Number(minimum[1]);
  if (Number(running[1]) >= needed) return null;
  const shown = nodeVersion.replace(/^v/, "");
  return `bykaranteli-mcp needs Node.js ${needed} or newer, and this is Node.js ${shown}. Install a current Node.js (https://nodejs.org) and start the server again.`;
}
