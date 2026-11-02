import { WHATSAPP_BASE_URL } from "../domain.js";

// A wa.me deep link that opens a chat with the number and a prefilled message. Built here; no WhatsApp API is called.
export const whatsappLink = (e164: string, message: string) => `${WHATSAPP_BASE_URL}${e164.slice(1)}?text=${encodeURIComponent(message)}`;

export const profileMessage = (displayName: string) => `Hola ${displayName}, vi su perfil en ChambaLink.`;
