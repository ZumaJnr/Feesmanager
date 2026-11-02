import { Router, type IRouter } from "express";
import healthRouter from "./health";
import feesRouter from "./fees";

const router: IRouter = Router();

router.use(healthRouter);
router.use(feesRouter);

export default router;
