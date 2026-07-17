export interface Pm2Info {
  pm2Instance: string | null;
  isLeader: boolean;
}

/**
 * Return PM2 instance info and whether this process should be treated as the leader.
 * - `pm2Instance` will be the string value of `NODE_APP_INSTANCE` or `pm_id`, or null
 *   when not running under PM2.
 * - `isLeader` is true when not running under PM2 (single process) or when the
 *   instance id is `"0"`.
 */
export function getPm2Info(): Pm2Info {
  // PM2-injected at runtime (present only under PM2); used to pick the leader
  // instance for one-time init. `pm_id` is PM2's own lowercase var name.
  const pm2Instance =
    process.env.NODE_APP_INSTANCE ?? process.env.pm_id ?? null;
  const isLeader = pm2Instance === null || pm2Instance === "0";
  return { pm2Instance, isLeader };
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
