import { loadDeployment as _load, type Deployment } from "@surelock-labs/protocol";
import * as fs from "fs";
import * as path from "path";

export type { Deployment };

export function loadDeployment(chainId: number | bigint): Deployment {
  const file = process.env["DEPLOYMENT_FILE"]
    ?? path.join(process.cwd(), "deployments", `${Number(chainId)}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as Deployment;
  return _load(Number(chainId));
}
