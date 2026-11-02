import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const studentsTable = pgTable("students", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  adm: text("adm").notNull().unique(),
  className: text("class_name").notNull(),
  totalFee: integer("total_fee").notNull(),
  balance: integer("balance").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Student = typeof studentsTable.$inferSelect;
