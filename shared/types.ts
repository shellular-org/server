import type express from "express";

/**
 * A router together with the path it is mounted at.
 * A convention we'll follow to export default all router modules from their respective files.
 */
export type RouteModule = {
  router: express.Router;
  prefix: string;
};
