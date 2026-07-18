import { Router, type IRouter } from "express";
import healthRouter from "./health";
import clinicRouter from "./clinic";
import insightsRouter from "./insights";

const router: IRouter = Router();

router.use(healthRouter);
router.use(clinicRouter);
router.use(insightsRouter);

export default router;
