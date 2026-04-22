import { loadDeployment as _load, type Deployment } from "@surelock-labs/protocol";
import * as fs from "fs";
import * as path from "path";

/**
 * Deployment as seen by scripts -- the on-disk `deployments/<chainId>.json`
 * carries `network` and `chainId` (string) fields in addition to the published
 * Deployment type. Keep this extension local to scripts; the published
 * `@surelock-labs/protocol` type stays minimal.
 */
export interface ScriptDeployment extends Deployment {
  chainId?: string;
  network?: string;
}

export type { ScriptDeployment as Deployment };

export function loadDeployment(chainId: number | bigint): ScriptDeployment {
  const file = process.env["DEPLOYMENT_FILE"]
    ?? path.join(process.cwd(), "deployments", `${Number(chainId)}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as ScriptDeployment;
  return _load(Number(chainId));
}
