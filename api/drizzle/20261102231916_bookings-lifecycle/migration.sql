-- A value added with ALTER TYPE ... ADD VALUE cannot be used before its transaction commits, and a migration runs in a
-- transaction, so the new exclusion predicate below could not name it. The enum is replaced instead; a type created
-- in the same transaction can be used at once. The old constraint depends on the column's type, so it goes first.
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_no_provider_overlap";--> statement-breakpoint
ALTER TYPE "booking_status" RENAME TO "booking_status_old";--> statement-breakpoint
CREATE TYPE "booking_status" AS ENUM('pending', 'confirmed', 'declined', 'cancelled', 'expired', 'completed');--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "status" TYPE "booking_status" USING "status"::text::"booking_status";--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "status" SET DEFAULT 'pending'::"booking_status";--> statement-breakpoint
DROP TYPE "booking_status_old";--> statement-breakpoint
-- service_id is NOT NULL without a default: on a table that already holds rows this statement fails, and the
-- migration with it, instead of inventing a service for them.
ALTER TABLE "bookings" ADD COLUMN "service_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "client_note" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "bookings_client_id_created_at_idx" ON "bookings" ("client_id","created_at","id");--> statement-breakpoint
CREATE INDEX "bookings_provider_id_created_at_idx" ON "bookings" ("provider_id","created_at","id");--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id");--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_client_note_length" CHECK (char_length("client_note") <= 500);--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_pending_expires" CHECK ("status" <> 'pending' OR "expires_at" IS NOT NULL);
--> statement-breakpoint
-- Pending, confirmed and completed bookings hold their slot; declined, cancelled and expired ones do not. A pending
-- booking past expires_at still holds it here, because an index predicate cannot depend on the time; the API marks such
-- rows expired before it inserts a booking for the provider (ADR 0014).
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_no_provider_overlap" EXCLUDE USING gist ("provider_id" WITH =, "during" WITH &&) WHERE ("status" IN ('pending', 'confirmed', 'completed'));
--> statement-breakpoint
-- SELECT was granted by 20261102225353_provider-catalog. Transitions and the expiry sweep write only these columns.
GRANT INSERT ON "bookings" TO "chambalink_app";
--> statement-breakpoint
GRANT UPDATE ("status", "updated_at") ON "bookings" TO "chambalink_app";
