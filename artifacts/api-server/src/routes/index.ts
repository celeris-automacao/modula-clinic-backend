import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import clinicRouter from "./clinic";
import insightsRouter from "./insights";
import profileRouter from "./profile";
import storageRouter from "./storage";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(clinicRouter);
router.use(insightsRouter);
router.use(profileRouter);
router.use(storageRouter);

export default router;
