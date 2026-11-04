import type { Category } from "../../../api/src/domain.ts";

// Booking statuses as stored in the booking_status enum (api/src/db/schema.ts).
export type BookingStatus = "pending" | "confirmed" | "declined" | "cancelled" | "expired" | "completed";

// Each family maps to the --cat-<family>-* tokens in web/src/styles/tokens.css.
export type CategoryFamily = "instalaciones" | "hogar" | "obra" | "personas" | "otros";

export interface CategoryStyle {
  family: CategoryFamily;
  label: string;
  // Tabler Icons outline name, rendered as `ti ti-<icon>`.
  icon: string;
}

export const CATEGORY_STYLES = {
  electrical: { family: "instalaciones", label: "Electricidad", icon: "bolt" },
  plumbing: { family: "instalaciones", label: "Fontanería", icon: "droplet" },
  mechanics: { family: "instalaciones", label: "Mecánica", icon: "tool" },
  cleaning: { family: "hogar", label: "Limpieza", icon: "spray" },
  gardening: { family: "hogar", label: "Jardinería", icon: "plant-2" },
  construction: { family: "obra", label: "Construcción", icon: "hammer" },
  beauty: { family: "personas", label: "Belleza", icon: "scissors" },
  tutoring: { family: "personas", label: "Clases", icon: "school" },
  other: { family: "otros", label: "Otro", icon: "dots" },
} as const satisfies Record<Category, CategoryStyle>;

export const FAMILY_LABELS = {
  instalaciones: "Instalaciones",
  hogar: "Hogar y jardín",
  obra: "Obra",
  personas: "Personas",
  otros: "Otros",
} as const satisfies Record<CategoryFamily, string>;

// Labels use "cita" (feminine): "Confirmada", not "Confirmado".
export const STATUS_LABELS = {
  pending: "Pendiente",
  confirmed: "Confirmada",
  declined: "Rechazada",
  cancelled: "Cancelada",
  expired: "Vencida",
  completed: "Completada",
} as const satisfies Record<BookingStatus, string>;
