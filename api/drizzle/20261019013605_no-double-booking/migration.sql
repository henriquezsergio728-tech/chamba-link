CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_during_bounded" CHECK (NOT isempty("during") AND NOT lower_inf("during") AND NOT upper_inf("during"));
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_no_provider_overlap" EXCLUDE USING gist ("provider_id" WITH =, "during" WITH &&) WHERE ("status" <> 'cancelled');
