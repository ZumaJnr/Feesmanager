import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CreateStudentBody,
  CreateStudentResponse,
  GetFeeSummaryResponse,
  ListRecentPaymentsQueryParams,
  ListRecentPaymentsResponse,
  ListStudentPaymentsParams,
  ListStudentPaymentsResponse,
  ListStudentsQueryParams,
  ListStudentsResponse,
  RecordStudentPaymentBody,
  RecordStudentPaymentParams,
  RecordStudentPaymentResponse,
} from "@workspace/api-zod";
import { db, paymentsTable, studentsTable } from "@workspace/db";

const router: IRouter = Router();

async function fetchPayments(limit: number, studentId?: number) {
  const query = db
    .select({
      id: paymentsTable.id,
      studentId: paymentsTable.studentId,
      studentName: studentsTable.name,
      amount: paymentsTable.amount,
      phone: paymentsTable.phone,
      receiptCode: paymentsTable.receiptCode,
      date: paymentsTable.date,
    })
    .from(paymentsTable)
    .innerJoin(studentsTable, eq(paymentsTable.studentId, studentsTable.id));

  if (studentId !== undefined) {
    return query
      .where(eq(paymentsTable.studentId, studentId))
      .orderBy(desc(paymentsTable.date))
      .limit(limit);
  }

  return query.orderBy(desc(paymentsTable.date)).limit(limit);
}

router.get("/fees/summary", async (_req, res): Promise<void> => {
  const [totals] = await db
    .select({
      studentCount: sql<number>`count(*)::int`,
      totalFees: sql<number>`coalesce(sum(${studentsTable.totalFee}), 0)::int`,
      outstandingBalance: sql<number>`coalesce(sum(${studentsTable.balance}), 0)::int`,
      studentsWithBalance: sql<number>`count(*) filter (where ${studentsTable.balance} > 0)::int`,
    })
    .from(studentsTable);

  const recentPayments = await fetchPayments(6);
  const summary = {
    ...totals,
    totalCollected: totals.totalFees - totals.outstandingBalance,
    recentPayments,
  };

  res.json(GetFeeSummaryResponse.parse(summary));
});

router.get("/students", async (req, res): Promise<void> => {
  const parsed = ListStudentsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const filters = [];
  const queryText = parsed.data.q?.trim();
  if (queryText) {
    filters.push(
      or(
        ilike(studentsTable.name, `%${queryText}%`),
        ilike(studentsTable.adm, `%${queryText}%`),
      )!,
    );
  }

  const className = parsed.data.className?.trim();
  if (className) {
    filters.push(eq(studentsTable.className, className));
  }

  const students = await db
    .select()
    .from(studentsTable)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(studentsTable.className), asc(studentsTable.name));

  res.json(ListStudentsResponse.parse(students));
});

router.post("/students", async (req, res): Promise<void> => {
  const parsed = CreateStudentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const name = parsed.data.name.trim();
  const adm = parsed.data.adm.trim();
  const className = parsed.data.className.trim();
  if (!name || !adm || !className) {
    res.status(400).json({ error: "Name, admission number, and class are required." });
    return;
  }

  const [student] = await db
    .insert(studentsTable)
    .values({
      name,
      adm,
      className,
      totalFee: parsed.data.totalFee,
      balance: parsed.data.totalFee,
    })
    .onConflictDoNothing({ target: studentsTable.adm })
    .returning();

  if (!student) {
    res.status(409).json({ error: "That admission number is already in use." });
    return;
  }

  res.status(201).json(CreateStudentResponse.parse(student));
});

router.get(
  "/students/:studentId/payments",
  async (req, res): Promise<void> => {
    const parsed = ListStudentPaymentsParams.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const [student] = await db
      .select({ id: studentsTable.id })
      .from(studentsTable)
      .where(eq(studentsTable.id, parsed.data.studentId));

    if (!student) {
      res.status(404).json({ error: "Student not found." });
      return;
    }

    const payments = await fetchPayments(100, parsed.data.studentId);
    res.json(ListStudentPaymentsResponse.parse(payments));
  },
);

router.post(
  "/students/:studentId/payments",
  async (req, res): Promise<void> => {
    const params = RecordStudentPaymentParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const body = RecordStudentPaymentBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }

    const phone = body.data.phone.trim();
    if (!/^\+?[0-9]{9,15}$/.test(phone)) {
      res.status(400).json({ error: "Enter a phone number using 9–15 digits." });
      return;
    }

    const receiptCode = `SF-${randomUUID().split("-")[0].toUpperCase()}`;
    const result = await db.transaction(async (tx) => {
      const [student] = await tx
        .select()
        .from(studentsTable)
        .where(eq(studentsTable.id, params.data.studentId))
        .for("update");

      if (!student) {
        return { status: "missing" as const };
      }

      if (body.data.amount > student.balance) {
        return {
          status: "over-balance" as const,
          balance: student.balance,
        };
      }

      const [payment] = await tx
        .insert(paymentsTable)
        .values({
          studentId: student.id,
          amount: body.data.amount,
          phone,
          receiptCode,
        })
        .returning();

      await tx
        .update(studentsTable)
        .set({ balance: student.balance - body.data.amount })
        .where(eq(studentsTable.id, student.id));

      return {
        status: "created" as const,
        payment: {
          ...payment,
          studentName: student.name,
        },
      };
    });

    if (result.status === "missing") {
      res.status(404).json({ error: "Student not found." });
      return;
    }

    if (result.status === "over-balance") {
      res.status(400).json({
        error: `Payment exceeds the remaining balance of KES ${result.balance}.`,
      });
      return;
    }

    res
      .status(201)
      .json(RecordStudentPaymentResponse.parse(result.payment));
  },
);

router.get("/payments", async (req, res): Promise<void> => {
  const parsed = ListRecentPaymentsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const payments = await fetchPayments(parsed.data.limit);
  res.json(ListRecentPaymentsResponse.parse(payments));
});

export default router;
