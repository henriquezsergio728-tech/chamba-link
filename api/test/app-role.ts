// The API's database role, created by migration 20261101043547_app-role.
export const APP_ROLE = "chambalink_app";

// The startup option makes every connection opened with this URL run as APP_ROLE. The URL's user must be a member of it or a superuser.
export function asAppRole(connectionString: string) {
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c role=${APP_ROLE}`);
  return url.toString();
}
