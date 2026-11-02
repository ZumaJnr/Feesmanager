import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { studentsTable } from "./students";

export const mpesaPaymentsTable = pgTable(
  "mpesa_payments",
  {
    id: text("id").primaryKey(),
    studentId: integer("student_id")
      .notNull()
      .references(() => studentsTable.id, { onDelete: "cascade" }),
    amount: integer("amount").notNull(),
    phone: text("phone").notNull(),
    status: text("status").notNull().default("pending"),
    merchantRequestId: text("merchant_request_id"),
    checkoutRequestId: text("checkout_request_id"),
    callbackAmount: integer("callback_amount"),
    callbackPhone: text("callback_phone"),
    receiptCode: text("receipt_code"),
    resultCode: integer("result_code"),
    resultDescription: text("result_description"),
    lastStatusCheckAt: timestamp("last_status_check_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("mpesa_payments_student_date_idx").on(table.studentId, table.createdAt),
    uniqueIndex("mpesa_payments_checkout_request_id_idx").on(
      table.checkoutRequestId,
    ),
  ],
);

export type MpesaPaymentAttempt = typeof mpesaPaymentsTable.$inferSelect;
