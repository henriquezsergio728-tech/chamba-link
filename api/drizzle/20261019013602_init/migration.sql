CREATE TYPE "account_role" AS ENUM('provider', 'client');--> statement-breakpoint
CREATE TYPE "booking_status" AS ENUM('pending', 'confirmed', 'cancelled');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"role" "account_role" NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"provider_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"during" tstzrange NOT NULL,
	"status" "booking_status" DEFAULT 'pending'::"booking_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_provider_id_accounts_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "accounts"("id");--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_client_id_accounts_id_fkey" FOREIGN KEY ("client_id") REFERENCES "accounts"("id");