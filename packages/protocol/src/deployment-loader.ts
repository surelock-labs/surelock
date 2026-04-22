import * as fs   from "fs";
import * as path from "path";
import { DEPLOYMENTS } from "./addresses";
import type { Deployment } from "./addresses";

/**
 * Load deployment info for a given chain ID.
 * Checks bundled DEPLOYMENTS first, then walks up from startDir looking for
 * deployments/<chainId>.json (useful for localhost and pre-publish networks).
 */
export function loadDeployment(chainId: number | bigint, startDir?: string): Deployment {
  const id      = chainId.toString();
  const bundled = (DEPLOYMENTS as Record<string, Deployment>)[id];
  if (bundled) return bundled;

  let dir = startDir ?? process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "deployments", `${id}.json`);
    if (fs.existsSync(candidate))
      return JSON.parse(fs.readFileSync(candidate, "utf8")) as Deployment;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(`No deployment found for chainId ${id}. Run deploy first.`);
}
