-- The API's role. NOLOGIN here; its login and password are set outside the repository. Roles are cluster-wide, so it may already exist.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'chambalink_app') THEN
    CREATE ROLE "chambalink_app" NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "public" TO "chambalink_app";
--> statement-breakpoint
-- Exactly what api/src runs. INSERT ... RETURNING and DELETE ... WHERE also need SELECT. bookings is not used by the API.
GRANT SELECT, INSERT ON "accounts" TO "chambalink_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON "account_credentials" TO "chambalink_app";
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "sessions" TO "chambalink_app";
--> statement-breakpoint
-- Append-only: no SELECT, UPDATE, DELETE or TRUNCATE. The identity column needs no sequence privilege.
GRANT INSERT ON "audit_log" TO "chambalink_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "rate_limits" TO "chambalink_app";
-- Tables created later get no privileges for this role; the migration that creates a table grants what the API needs.
