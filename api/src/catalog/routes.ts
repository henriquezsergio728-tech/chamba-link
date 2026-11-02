import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { and, asc, desc, eq, ilike, sql, type SQL } from "drizzle-orm";
import { Type } from "typebox";
import { accounts, providerProfiles, services } from "../db/schema.js";
import { CURRENCY, SLOTS_MAX_RANGE_DAYS, TIMEZONE } from "../domain.js";
import { AppError } from "../errors.js";
import { decodeCursor, page, PAGE_LIMIT_DEFAULT, PageQuery } from "../pagination.js";
import { profileMessage, whatsappLink } from "../providers/whatsapp.js";
import { Category, Department, IdParams, Nullable, Timestamp, Uuid } from "../schemas.js";
import { addMinutes, formatLocal } from "../time.js";
import { loadBlockingBookings, loadRules, loadTimeOff } from "./availability.js";
import { CATALOG_CACHE_CONTROL, cacheControlOn200, publicCache, SLOTS_CACHE_CONTROL } from "./http-cache.js";
import { computeSlots } from "./slots.js";

const PublicService = Type.Object({
  id: Uuid,
  title: Type.String(),
  description: Type.String(),
  category: Category,
  priceFromCents: Nullable(Type.Integer()),
  currency: Type.Literal(CURRENCY),
  durationMinutes: Type.Integer(),
  createdAt: Timestamp,
});

const CatalogService = Type.Object({
  ...PublicService.properties,
  provider: Type.Object({ id: Uuid, displayName: Type.String(), department: Department, municipality: Type.String() }),
});

const ProviderBody = Type.Object({
  provider: Type.Object({
    id: Uuid,
    displayName: Type.String(),
    headline: Type.String(),
    bio: Type.String(),
    department: Department,
    municipality: Type.String(),
    whatsappLink: Nullable(Type.String()),
    services: Type.Array(PublicService),
  }),
});

const SlotsBody = Type.Object({
  providerId: Uuid,
  serviceId: Uuid,
  durationMinutes: Type.Integer(),
  timezone: Type.String(),
  slots: Type.Array(Type.Object({ start: Timestamp, end: Timestamp })),
});

const publicServiceColumns = {
  id: services.id,
  title: services.title,
  description: services.description,
  category: services.category,
  priceFromCents: services.priceFromCents,
  durationMinutes: services.durationMinutes,
  createdAt: services.createdAt,
};

const publicServiceBody = (row: { id: string; title: string; description: string; category: string; priceFromCents: number | null; durationMinutes: number; createdAt: Date }) => ({
  ...row,
  category: row.category as Category,
  currency: CURRENCY,
  createdAt: formatLocal(row.createdAt),
});

const notFound = (detail: string) => new AppError({ status: 404, code: "NOT_FOUND", title: "Not Found", detail });

// LIKE treats %, _ and the escape character \ specially; escaped, q matches as a plain substring.
const likeEscape = (value: string) => value.replace(/[\\%_]/g, "\\$&");

// Public routes: no session is read, and successful responses may be cached by browsers and shared caches.
export const catalogRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    "/services",
    {
      onSend: publicCache(CATALOG_CACHE_CONTROL),
      schema: {
        querystring: Type.Object({
          category: Type.Optional(Category),
          department: Type.Optional(Department),
          q: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
          ...PageQuery,
        }),
        response: { 200: Type.Object({ services: Type.Array(CatalogService), nextCursor: Nullable(Type.String()) }) },
      },
    },
    async (request) => {
      const { category, department, q, cursor } = request.query;
      const limit = request.query.limit ?? PAGE_LIMIT_DEFAULT;
      const filters: (SQL | undefined)[] = [eq(services.active, true)];
      if (category) filters.push(eq(services.category, category));
      if (department) filters.push(eq(providerProfiles.department, department));
      if (q) filters.push(ilike(services.title, `%${likeEscape(q)}%`));
      if (cursor) {
        const after = decodeCursor(cursor);
        filters.push(sql`(${services.createdAt}, ${services.id}) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`);
      }
      const rows = await app.db
        .select({
          ...publicServiceColumns,
          cursorAt: sql<string>`${services.createdAt}::text`,
          providerId: services.providerId,
          displayName: accounts.displayName,
          department: providerProfiles.department,
          municipality: providerProfiles.municipality,
        })
        .from(services)
        .innerJoin(providerProfiles, eq(providerProfiles.accountId, services.providerId))
        .innerJoin(accounts, eq(accounts.id, services.providerId))
        .where(and(...filters))
        .orderBy(desc(services.createdAt), desc(services.id))
        .limit(limit + 1);
      const { items, nextCursor } = page(
        rows.map((r) => ({ ...r, cursor: { createdAt: r.cursorAt, id: r.id } })),
        limit,
      );
      return {
        services: items.map(({ cursorAt: _, cursor: __, providerId, displayName, department: dept, municipality, ...service }) => ({
          ...publicServiceBody(service),
          provider: { id: providerId, displayName, department: dept as Department, municipality },
        })),
        nextCursor,
      };
    },
  );

  app.get(
    "/providers/:id",
    { onSend: publicCache(CATALOG_CACHE_CONTROL), schema: { params: IdParams, response: { 200: ProviderBody } } },
    async (request) => {
      const [profile] = await app.db
        .select({
          id: providerProfiles.accountId,
          displayName: accounts.displayName,
          headline: providerProfiles.headline,
          bio: providerProfiles.bio,
          department: providerProfiles.department,
          municipality: providerProfiles.municipality,
          whatsappE164: providerProfiles.whatsappE164,
        })
        .from(providerProfiles)
        .innerJoin(accounts, eq(accounts.id, providerProfiles.accountId))
        .where(eq(providerProfiles.accountId, request.params.id));
      if (!profile) throw notFound("No such provider");
      const rows = await app.db
        .select(publicServiceColumns)
        .from(services)
        .where(and(eq(services.providerId, profile.id), eq(services.active, true)))
        .orderBy(asc(services.createdAt), asc(services.id));
      const { whatsappE164, ...rest } = profile;
      return {
        provider: {
          ...rest,
          department: rest.department as Department,
          whatsappLink: whatsappE164 ? whatsappLink(whatsappE164, profileMessage(profile.displayName)) : null,
          services: rows.map(publicServiceBody),
        },
      };
    },
  );

  app.get(
    "/providers/:id/slots",
    {
      onSend: cacheControlOn200(SLOTS_CACHE_CONTROL),
      schema: {
        params: IdParams,
        querystring: Type.Object({ serviceId: Uuid, from: Timestamp, to: Timestamp }),
        response: { 200: SlotsBody },
      },
    },
    async (request) => {
      const from = new Date(request.query.from);
      const to = new Date(request.query.to);
      if (to <= from || to.getTime() - from.getTime() > SLOTS_MAX_RANGE_DAYS * 86_400_000) {
        throw new AppError({ status: 422, code: "INVALID_RANGE", title: "Unprocessable Content", detail: `to must be after from and at most ${SLOTS_MAX_RANGE_DAYS} days later` });
      }
      const [service] = await app.db
        .select({ durationMinutes: services.durationMinutes })
        .from(services)
        .where(and(eq(services.id, request.query.serviceId), eq(services.providerId, request.params.id), eq(services.active, true)));
      if (!service) throw notFound("No such active service for this provider");

      const now = new Date();
      // A slot that starts before `to` may end up to one service duration later.
      const until = addMinutes(to, service.durationMinutes);
      const [rules, off, booked] = await Promise.all([
        loadRules(app.db, request.params.id),
        loadTimeOff(app.db, request.params.id, from, until),
        loadBlockingBookings(app.db, request.params.id, from, until),
      ]);
      const slots = computeSlots({ rules, blocked: [...off, ...booked], durationMinutes: service.durationMinutes, from, to, now });
      return {
        providerId: request.params.id,
        serviceId: request.query.serviceId,
        durationMinutes: service.durationMinutes,
        timezone: TIMEZONE,
        slots: slots.map((s) => ({ start: formatLocal(s.start), end: formatLocal(s.end) })),
      };
    },
  );
};
