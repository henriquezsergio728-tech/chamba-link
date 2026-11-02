// Fixed product decisions. They are constants, not configuration: changing one changes the API's behaviour for every
// deployment, so it goes through a code change and review. See ADR 0014.

// One timezone for every provider and client. El Salvador does not observe daylight saving time, so local wall-clock
// time is always UTC-6 and conversions use the fixed offset.
export const TIMEZONE = "America/El_Salvador";
export const UTC_OFFSET_MINUTES = -360;

export const CURRENCY = "USD" as const;

export const CATEGORIES = ["plumbing", "electrical", "cleaning", "gardening", "beauty", "mechanics", "construction", "tutoring", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

export const DEPARTMENTS = [
  "ahuachapan",
  "santa-ana",
  "sonsonate",
  "chalatenango",
  "la-libertad",
  "san-salvador",
  "cuscatlan",
  "la-paz",
  "cabanas",
  "san-vicente",
  "usulutan",
  "san-miguel",
  "morazan",
  "la-union",
] as const;
export type Department = (typeof DEPARTMENTS)[number];

// Slots start on the local half-hour grid; a service lasts a whole number of steps.
export const SLOT_STEP_MINUTES = 30;
export const SERVICE_DURATION_MIN_MINUTES = 30;
export const SERVICE_DURATION_MAX_MINUTES = 480;

// A slot starts at least this long from now and at most this far ahead.
export const BOOKING_MIN_LEAD_MINUTES = 60;
export const BOOKING_HORIZON_DAYS = 60;

// A pending booking lapses this long after creation, or at its start time if that comes sooner.
export const PENDING_HOLD_HOURS = 24;

// The longest range GET /v1/providers/:id/slots answers for.
export const SLOTS_MAX_RANGE_DAYS = 14;

export const WHATSAPP_BASE_URL = "https://wa.me/";
