import { Router, type IRouter } from "express";
import healthRouter from "./health";
import feesRouter from "./fees";
import mpesaRouter from "./mpesa";

const router: IRouter = Router();

router.use(healthRouter);
router.use(feesRouter);
router.use(mpesaRouter);

export default router;
