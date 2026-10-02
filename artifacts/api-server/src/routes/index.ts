import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import teamRouter from "./team";
import campaignsRouter from "./campaigns";
import importsRouter from "./imports";
import safetyRouter from "./safety";
import unsubscribeRouter from "./unsubscribe";
import engagementRouter from "./engagement";
import recipientExclusionsRouter from "./recipient-exclusions";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(teamRouter);
router.use(campaignsRouter);
router.use(importsRouter);
router.use(safetyRouter);
router.use(unsubscribeRouter);
router.use(engagementRouter);
router.use(recipientExclusionsRouter);

export default router;
