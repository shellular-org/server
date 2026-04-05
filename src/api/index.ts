import { Router } from "express";
import authenticate from "middleware/authenticate";
import v1 from "./v1";

const router = Router();

router.use((req, res, next) => {
	if (!req.user) {
		return res.status(401).json({ error: "Unauthorized" });
	}
	next();
});
router.use(v1);

export default Router().use("/api", authenticate, router);
