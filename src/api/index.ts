import { Router } from "express";
import authenticate from "middleware/authenticate";
import v1 from "./v1";

const router = Router();

router.use(v1);

export default Router().use("/api", authenticate, router);
