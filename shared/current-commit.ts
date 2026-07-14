import { execSync } from "node:child_process";

export const GIT_COMMIT = (() => {
  try {
    const sha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    const message = execSync("git log -1 --pretty=%s", {
      encoding: "utf8",
    }).trim();
    return { sha, message };
  } catch {
    return { sha: "unknown", message: "unknown" };
  }
})();
