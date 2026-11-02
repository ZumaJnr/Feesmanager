import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { studentsTable } from "./students";

export const paymentsTable = pgTable(
  "payments",
  {
    id: serial("id").primaryKey(),
    studentId: integer("student_id")
      .notNull()
      .references(() => studentsTable.id, { onDelete: "cascade" }),
    amount: integer("amount").notNull(),
    phone: text("phone").notNull(),
    receiptCode: text("receipt_code").notNull().unique(),
    date: timestamp("date", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("payments_student_date_idx").on(table.studentId, table.date)],
);

export type Payment = typeof paymentsTable.$inferSelect;
