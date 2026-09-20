import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import campaignsRouter from "./campaigns";
import importsRouter from "./imports";
import safetyRouter from "./safety";
import unsubscribeRouter from "./unsubscribe";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(campaignsRouter);
router.use(importsRouter);
router.use(safetyRouter);
router.use(unsubscribeRouter);

export default router;
