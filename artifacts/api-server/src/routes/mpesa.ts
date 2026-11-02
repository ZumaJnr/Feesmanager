import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  GetMpesaConfigResponse,
  GetMpesaPaymentStatusParams,
  GetMpesaPaymentStatusResponse,
  ListStudentMpesaPaymentsParams,
  ListStudentMpesaPaymentsResponse,
  ReceiveMpesaCallbackBody,
  StartMpesaPaymentBody,
  StartMpesaPaymentParams,
  StartMpesaPaymentResponse,
} from "@workspace/api-zod";
import {
  db,
  mpesaPaymentsTable,
  paymentsTable,
  studentsTable,
} from "@workspace/db";
import {
  getMpesaConfig,
  normalizeKenyanPhoneNumber,
  queryStkPush,
  startStkPush,
} from "../lib/mpesa";

const router: IRouter = Router();
const ACTIVE_STATUSES = ["pending", "verifying"] as const;
const STATUS_QUERY_COOLDOWN_MS = 15_000;

type Attempt = typeof mpesaPaymentsTable.$inferSelect;

function serializeAttempt(attempt: Attempt) {
  const status = ACTIVE_STATUSES.includes(
    attempt.status as (typeof ACTIVE_STATUSES)[number],
  )
    ? attempt.status
    : attempt.status === "paid"
      ? "paid"
      : "failed";
  const message =
    status === "pending"
      ? "Check your phone and approve the Safaricom prompt."
      : status === "verifying"
        ? "Waiting for Safaricom to confirm the payment."
        : status === "paid"
          ? "Payment confirmed by Safaricom."
          : attempt.resultDescription ?? "The payment was not completed.";

  return {
    id: attempt.id,
    studentId: attempt.studentId,
    amount: attempt.amount,
    phone: attempt.phone,
    status,
    receiptCode: attempt.receiptCode,
    message,
    createdAt: attempt.createdAt,
  };
}

function callbackItem(
  items: Array<{ Name?: string; Value?: string | number | null }> | undefined,
  name: string,
): string | number | undefined {
  const value = items?.find((item) => item.Name === name)?.Value;
  return typeof value === "string" || typeof value === "number"
    ? value
    : undefined;
}

async function attemptProviderConfirmation(paymentId: string): Promise<void> {
  const [attempt] = await db
    .select()
    .from(mpesaPaymentsTable)
    .where(eq(mpesaPaymentsTable.id, paymentId));

  if (
    !attempt ||
    attempt.status !== "verifying" ||
    !attempt.checkoutRequestId ||
    attempt.lastStatusCheckAt &&
      Date.now() - attempt.lastStatusCheckAt.getTime() < STATUS_QUERY_COOLDOWN_MS
  ) {
    return;
  }

  const checkedAt = new Date();
  const claimed = await db
    .update(mpesaPaymentsTable)
    .set({ lastStatusCheckAt: checkedAt })
    .where(
      and(
        eq(mpesaPaymentsTable.id, paymentId),
        eq(mpesaPaymentsTable.status, "verifying"),
        or(
          isNull(mpesaPaymentsTable.lastStatusCheckAt),
          lt(
            mpesaPaymentsTable.lastStatusCheckAt,
            new Date(checkedAt.getTime() - STATUS_QUERY_COOLDOWN_MS),
          ),
        ),
      ),
    )
    .returning({ id: mpesaPaymentsTable.id });
  if (!claimed.length) return;

  let providerResult;
  try {
    providerResult = await queryStkPush(attempt.checkoutRequestId);
  } catch {
    return;
  }

  if (String(providerResult.CheckoutRequestID) !== attempt.checkoutRequestId) {
    return;
  }

  const providerCode = Number(providerResult.ResultCode);
  if (!Number.isInteger(providerCode)) return;

  if (providerCode !== 0) {
    if (attempt.resultCode !== null && attempt.resultCode !== 0) {
      await db
        .update(mpesaPaymentsTable)
        .set({
          status: "failed",
          resultCode: providerCode,
          resultDescription:
            typeof providerResult.ResultDesc === "string"
              ? providerResult.ResultDesc.slice(0, 240)
              : "Safaricom reports that the payment was not completed.",
        })
        .where(
          and(
            eq(mpesaPaymentsTable.id, paymentId),
            eq(mpesaPaymentsTable.status, "verifying"),
          ),
        );
    }
    return;
  }

  if (
    attempt.resultCode !== 0 ||
    attempt.callbackAmount !== attempt.amount ||
    attempt.callbackPhone !== attempt.phone ||
    !attempt.receiptCode
  ) {
    return;
  }

  await db.transaction(async (tx) => {
    const [currentAttempt] = await tx
      .select()
      .from(mpesaPaymentsTable)
      .where(eq(mpesaPaymentsTable.id, paymentId))
      .for("update");
    if (!currentAttempt || currentAttempt.status !== "verifying") return;

    const [student] = await tx
      .select()
      .from(studentsTable)
      .where(eq(studentsTable.id, currentAttempt.studentId))
      .for("update");
    if (!student) {
      await tx
        .update(mpesaPaymentsTable)
        .set({
          status: "failed",
          resultDescription: "The student account no longer exists.",
        })
        .where(eq(mpesaPaymentsTable.id, paymentId));
      return;
    }

    const [payment] = await tx
      .insert(paymentsTable)
      .values({
        studentId: currentAttempt.studentId,
        amount: currentAttempt.amount,
        phone: currentAttempt.phone,
        receiptCode: currentAttempt.receiptCode!,
      })
      .onConflictDoNothing({ target: paymentsTable.receiptCode })
      .returning({ id: paymentsTable.id });

    if (!payment) {
      await tx
        .update(mpesaPaymentsTable)
        .set({
          status: "failed",
          resultDescription: "Safaricom receipt was already recorded.",
        })
        .where(eq(mpesaPaymentsTable.id, paymentId));
      return;
    }

    await tx
      .update(studentsTable)
      .set({
        balance: sql`greatest(${studentsTable.balance} - ${currentAttempt.amount}, 0)`,
      })
      .where(eq(studentsTable.id, student.id));

    await tx
      .update(mpesaPaymentsTable)
      .set({
        status: "paid",
        resultCode: 0,
        resultDescription: "Payment confirmed by Safaricom.",
      })
      .where(eq(mpesaPaymentsTable.id, paymentId));
  });
}

router.get("/mpesa/config", (_req, res): void => {
  res.json(GetMpesaConfigResponse.parse(getMpesaConfig()));
});

router.get(
  "/students/:studentId/mpesa-payments",
  async (req, res): Promise<void> => {
    const params = ListStudentMpesaPaymentsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const [student] = await db
      .select({ id: studentsTable.id })
      .from(studentsTable)
      .where(eq(studentsTable.id, params.data.studentId));
    if (!student) {
      res.status(404).json({ error: "Student not found." });
      return;
    }

    const attempts = await db
      .select()
      .from(mpesaPaymentsTable)
      .where(eq(mpesaPaymentsTable.studentId, student.id))
      .orderBy(desc(mpesaPaymentsTable.createdAt))
      .limit(20);
    await Promise.all(
      attempts
        .filter((attempt) => attempt.status === "verifying")
        .slice(0, 5)
        .map((attempt) => attemptProviderConfirmation(attempt.id)),
    );
    const refreshedAttempts = await db
      .select()
      .from(mpesaPaymentsTable)
      .where(eq(mpesaPaymentsTable.studentId, student.id))
      .orderBy(desc(mpesaPaymentsTable.createdAt))
      .limit(20);
    res.json(
      ListStudentMpesaPaymentsResponse.parse(
        refreshedAttempts.map(serializeAttempt),
      ),
    );
  },
);

router.post(
  "/students/:studentId/mpesa-payments",
  async (req, res): Promise<void> => {
    const params = StartMpesaPaymentParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const body = StartMpesaPaymentBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }

    const config = getMpesaConfig();
    if (!config.available) {
      res.status(503).json({ error: config.message });
      return;
    }

    const phone = normalizeKenyanPhoneNumber(body.data.phone);
    if (!phone) {
      res.status(400).json({
        error: "Enter a valid Kenyan mobile number, such as 0712 345 678.",
      });
      return;
    }

    const paymentId = randomUUID();
    const reservation = await db.transaction(async (tx) => {
      const [student] = await tx
        .select()
        .from(studentsTable)
        .where(eq(studentsTable.id, params.data.studentId))
        .for("update");
      if (!student) return { status: "missing" as const };

      const [reserved] = await tx
        .select({
          amount: sql<number>`coalesce(sum(${mpesaPaymentsTable.amount}), 0)::int`,
        })
        .from(mpesaPaymentsTable)
        .where(
          and(
            eq(mpesaPaymentsTable.studentId, student.id),
            inArray(mpesaPaymentsTable.status, [...ACTIVE_STATUSES]),
          ),
        );
      const availableBalance = Math.max(
        student.balance - Number(reserved.amount ?? 0),
        0,
      );
      if (body.data.amount > availableBalance) {
        return {
          status: "over-balance" as const,
          balance: availableBalance,
        };
      }

      const [attempt] = await tx
        .insert(mpesaPaymentsTable)
        .values({
          id: paymentId,
          studentId: student.id,
          amount: body.data.amount,
          phone,
          status: "pending",
        })
        .returning();
      return { status: "created" as const, attempt };
    });

    if (reservation.status === "missing") {
      res.status(404).json({ error: "Student not found." });
      return;
    }
    if (reservation.status === "over-balance") {
      res.status(400).json({
        error: `Payment exceeds the available balance of KES ${reservation.balance}.`,
      });
      return;
    }

    try {
      const providerRequest = await startStkPush({
        amount: body.data.amount,
        phone,
        accountReference: `SF${paymentId.replace(/-/g, "").slice(0, 8)}`,
      });
      const [attempt] = await db
        .update(mpesaPaymentsTable)
        .set({
          merchantRequestId: providerRequest.merchantRequestId,
          checkoutRequestId: providerRequest.checkoutRequestId,
        })
        .where(eq(mpesaPaymentsTable.id, paymentId))
        .returning();

      res
        .status(201)
        .json(StartMpesaPaymentResponse.parse(serializeAttempt(attempt)));
    } catch {
      await db
        .update(mpesaPaymentsTable)
        .set({
          status: "failed",
          resultDescription:
            "Safaricom could not start the payment prompt. Please try again.",
        })
        .where(eq(mpesaPaymentsTable.id, paymentId));
      req.log.warn({ paymentId }, "Safaricom STK Push request failed");
      res.status(502).json({
        error: "Safaricom could not start the payment prompt. Please try again.",
      });
    }
  },
);

router.get(
  "/mpesa-payments/:paymentId",
  async (req, res): Promise<void> => {
    const params = GetMpesaPaymentStatusParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const [attempt] = await db
      .select()
      .from(mpesaPaymentsTable)
      .where(eq(mpesaPaymentsTable.id, params.data.paymentId));
    if (!attempt) {
      res.status(404).json({ error: "M-Pesa payment request not found." });
      return;
    }

    if (attempt.status === "verifying") {
      await attemptProviderConfirmation(attempt.id);
    }

    const [latest] = await db
      .select()
      .from(mpesaPaymentsTable)
      .where(eq(mpesaPaymentsTable.id, attempt.id));
    res.json(
      GetMpesaPaymentStatusResponse.parse(serializeAttempt(latest ?? attempt)),
    );
  },
);

router.post("/mpesa/callback", async (req, res): Promise<void> => {
  const body = ReceiveMpesaCallbackBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid M-Pesa callback." });
    return;
  }

  const callback = body.data.Body.stkCallback;
  const [attempt] = await db
    .select()
    .from(mpesaPaymentsTable)
    .where(eq(mpesaPaymentsTable.checkoutRequestId, callback.CheckoutRequestID));
  if (!attempt) {
    req.log.warn(
      { checkoutRequestId: callback.CheckoutRequestID },
      "Received callback for an unknown checkout request",
    );
    res.json({ ResultCode: 0, ResultDesc: "Callback received." });
    return;
  }
  if (attempt.status === "paid" || attempt.status === "failed") {
    res.json({ ResultCode: 0, ResultDesc: "Callback already processed." });
    return;
  }

  const items = body.data.Body.stkCallback.CallbackMetadata?.Item;
  const amountValue = callbackItem(items, "Amount");
  const phoneValue = callbackItem(items, "PhoneNumber");
  const receiptValue = callbackItem(items, "MpesaReceiptNumber");
  const callbackPhone =
    phoneValue === undefined
      ? undefined
      : normalizeKenyanPhoneNumber(String(phoneValue));
  const callbackAmount =
    amountValue === undefined ? undefined : Number(amountValue);
  const receiptCode =
    typeof receiptValue === "string" ? receiptValue.trim() : undefined;

  const callbackSucceeded =
    callback.ResultCode === 0 &&
    callbackAmount === attempt.amount &&
    callbackPhone === attempt.phone &&
    Boolean(receiptCode);
  const callbackDescription =
    callback.ResultCode === 0 && !callbackSucceeded
      ? "Safaricom callback details did not match the request; manual review is required."
      : callback.ResultDesc;

  await db
    .update(mpesaPaymentsTable)
    .set({
      status: "verifying",
      merchantRequestId:
        callback.MerchantRequestID ?? attempt.merchantRequestId,
      resultCode: callback.ResultCode,
      resultDescription: callbackDescription.slice(0, 240),
      callbackAmount:
        callbackSucceeded && callbackAmount !== undefined
          ? callbackAmount
          : null,
      callbackPhone: callbackSucceeded ? callbackPhone ?? null : null,
      receiptCode: callbackSucceeded ? receiptCode ?? null : null,
      lastStatusCheckAt: null,
    })
    .where(
      and(
        eq(mpesaPaymentsTable.id, attempt.id),
        inArray(mpesaPaymentsTable.status, [...ACTIVE_STATUSES]),
      ),
    );

  void attemptProviderConfirmation(attempt.id).catch(() => {
    req.log.warn({ paymentId: attempt.id }, "M-Pesa callback verification failed");
  });
  res.json({ ResultCode: 0, ResultDesc: "Callback received." });
});

export default router;
