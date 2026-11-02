CREATE TABLE "availability_rules" (
	"provider_id" uuid,
	"weekday" smallint,
	"start_time" time,
	"end_time" time NOT NULL,
	CONSTRAINT "availability_rules_pkey" PRIMARY KEY("provider_id","weekday","start_time"),
	CONSTRAINT "availability_rules_weekday" CHECK ("weekday" BETWEEN 0 AND 6),
	CONSTRAINT "availability_rules_end_after_start" CHECK ("end_time" > "start_time")
);
--> statement-breakpoint
CREATE TABLE "provider_profiles" (
	"account_id" uuid PRIMARY KEY,
	"role" "account_role" DEFAULT 'provider'::"account_role" NOT NULL,
	"headline" text NOT NULL,
	"bio" text NOT NULL,
	"department" text NOT NULL,
	"municipality" text NOT NULL,
	"whatsapp_e164" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_profiles_role_provider" CHECK ("role" = 'provider'),
	CONSTRAINT "provider_profiles_whatsapp_e164" CHECK ("whatsapp_e164" ~ '^\+[1-9][0-9]{7,14}$')
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"provider_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"category" text NOT NULL,
	"price_from_cents" integer,
	"duration_minutes" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "services_price_from_cents_nonnegative" CHECK ("price_from_cents" >= 0),
	CONSTRAINT "services_duration_minutes_steps" CHECK ("duration_minutes" BETWEEN 30 AND 480 AND "duration_minutes" % 30 = 0)
);
--> statement-breakpoint
CREATE TABLE "time_off" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"provider_id" uuid NOT NULL,
	"during" tstzrange NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_off_during_bounded" CHECK (NOT isempty("during") AND NOT lower_inf("during") AND NOT upper_inf("during"))
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_id_role_key" UNIQUE("id","role");--> statement-breakpoint
CREATE INDEX "services_provider_id_idx" ON "services" ("provider_id");--> statement-breakpoint
CREATE INDEX "services_created_at_id_idx" ON "services" ("created_at","id");--> statement-breakpoint
CREATE INDEX "time_off_provider_id_during_idx" ON "time_off" USING gist ("provider_id","during");--> statement-breakpoint
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "provider_profiles"("account_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "provider_profiles" ADD CONSTRAINT "provider_profiles_account_fkey" FOREIGN KEY ("account_id","role") REFERENCES "accounts"("id","role") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "provider_profiles"("account_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "provider_profiles"("account_id") ON DELETE CASCADE;--> statement-breakpoint
-- Rules for one provider and weekday must not overlap. time has no range type, so each rule is compared as a tsrange on
-- a fixed date; date + time is immutable, as an exclusion constraint requires. end_time 24:00 maps to the next midnight.
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_no_overlap" EXCLUDE USING gist ("provider_id" WITH =, "weekday" WITH =, tsrange(DATE '2000-01-01' + "start_time", DATE '2000-01-01' + "end_time") WITH &&);
--> statement-breakpoint
-- Exactly what api/src runs on these tables (ADR 0013). UPDATE is limited to the columns the API writes.
GRANT SELECT, INSERT ON "provider_profiles" TO "chambalink_app";
--> statement-breakpoint
GRANT UPDATE ("headline", "bio", "department", "municipality", "whatsapp_e164", "updated_at") ON "provider_profiles" TO "chambalink_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON "services" TO "chambalink_app";
--> statement-breakpoint
GRANT UPDATE ("title", "description", "category", "price_from_cents", "duration_minutes", "active") ON "services" TO "chambalink_app";
--> statement-breakpoint
-- PUT /v1/providers/me/availability replaces the rules with DELETE and INSERT.
GRANT SELECT, INSERT, DELETE ON "availability_rules" TO "chambalink_app";
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "time_off" TO "chambalink_app";
--> statement-breakpoint
-- The slots query reads the bookings that block a slot.
GRANT SELECT ON "bookings" TO "chambalink_app";
