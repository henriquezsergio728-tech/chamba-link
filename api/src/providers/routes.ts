import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { Type } from "typebox";
import { audit, type AuditEvent, type Queryable } from "../audit.js";
import { requireRole } from "../auth/session.js";
import { availabilityRules, providerProfiles, services, timeOff } from "../db/schema.js";
import { CURRENCY, SERVICE_DURATION_MAX_MINUTES, SERVICE_DURATION_MIN_MINUTES, SLOT_STEP_MINUTES, TIMEZONE } from "../domain.js";
import { AppError } from "../errors.js";
import { Category, Department, IdParams, Nullable, Timestamp, Uuid } from "../schemas.js";
import { formatClock, formatLocal, parseClock, tstzrangeLiteral } from "../time.js";

const E164 = Type.String({ pattern: "^\\+[1-9][0-9]{7,14}$" });

const ProfileInput = Type.Object({
  headline: Type.String({ minLength: 1, maxLength: 120 }),
  bio: Type.String({ maxLength: 2000 }),
  department: Department,
  municipality: Type.String({ minLength: 1, maxLength: 80 }),
  whatsappE164: Type.Optional(Nullable(E164)),
});

const ProfileBody = Type.Object({
  profile: Type.Object({
    accountId: Uuid,
    displayName: Type.String(),
    headline: Type.String(),
    bio: Type.String(),
    department: Department,
    municipality: Type.String(),
    whatsappE164: Nullable(Type.String()),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  }),
});

const Title = Type.String({ minLength: 1, maxLength: 120 });
const Description = Type.String({ maxLength: 2000 });
// Postgres integer range.
const PriceFromCents = Nullable(Type.Integer({ minimum: 0, maximum: 2_147_483_647 }));
const Duration = Type.Integer({ minimum: SERVICE_DURATION_MIN_MINUTES, maximum: SERVICE_DURATION_MAX_MINUTES, multipleOf: SLOT_STEP_MINUTES });

export const Service = Type.Object({
  id: Uuid,
  title: Type.String(),
  description: Type.String(),
  category: Category,
  priceFromCents: Nullable(Type.Integer()),
  currency: Type.Literal(CURRENCY),
  durationMinutes: Type.Integer(),
  active: Type.Boolean(),
  createdAt: Timestamp,
});

// Rule times are local wall-clock times on the half-hour grid; an end of 24:00 is midnight at the end of the day.
const StartClock = Type.String({ pattern: "^([01][0-9]|2[0-3]):(00|30)$" });
const EndClock = Type.String({ pattern: "^(([01][0-9]|2[0-3]):(00|30)|24:00)$" });
const Rule = Type.Object({ weekday: Type.Integer({ minimum: 0, maximum: 6 }), start: StartClock, end: EndClock });
const AvailabilityBody = Type.Object({ timezone: Type.String(), rules: Type.Array(Rule) });

const TimeOff = Type.Object({ id: Uuid, start: Timestamp, end: Timestamp, createdAt: Timestamp });

const unprocessable = (code: string, detail: string) => new AppError({ status: 422, code, title: "Unprocessable Content", detail });
const notFound = (detail: string) => new AppError({ status: 404, code: "NOT_FOUND", title: "Not Found", detail });

const serviceColumns = {
  id: services.id,
  title: services.title,
  description: services.description,
  category: services.category,
  priceFromCents: services.priceFromCents,
  durationMinutes: services.durationMinutes,
  active: services.active,
  createdAt: services.createdAt,
};

type ServiceRow = {
  id: string;
  title: string;
  description: string;
  category: string;
  priceFromCents: number | null;
  durationMinutes: number;
  active: boolean;
  createdAt: Date;
};

export const serviceBody = (row: ServiceRow) => ({
  ...row,
  category: row.category as Category,
  currency: CURRENCY,
  createdAt: formatLocal(row.createdAt),
});

const timeOffColumns = {
  id: timeOff.id,
  start: sql`lower(${timeOff.during})`.mapWith(timeOff.createdAt),
  end: sql`upper(${timeOff.during})`.mapWith(timeOff.createdAt),
  createdAt: timeOff.createdAt,
};

const timeOffBody = (row: { id: string; start: Date; end: Date; createdAt: Date }) => ({
  id: row.id,
  start: formatLocal(row.start),
  end: formatLocal(row.end),
  createdAt: formatLocal(row.createdAt),
});

// Services, availability and time off belong to a profile, so the profile is created first.
async function requireProfile(db: Queryable, accountId: string, lock = false) {
  const query = db.select({ accountId: providerProfiles.accountId }).from(providerProfiles).where(eq(providerProfiles.accountId, accountId));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw new AppError({ status: 409, code: "PROFILE_REQUIRED", title: "Conflict", detail: "Create the provider profile first" });
}

export const providerRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // Responses carry the provider's own data, so no cache may keep them. Error responses included.
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("cache-control", "no-store");
  });
  app.addHook("preHandler", requireRole("provider"));

  const security = [{ cookieAuth: [] }];
  const me = (request: FastifyRequest) => request.account!;
  const record = (db: Queryable, request: FastifyRequest, event: AuditEvent, metadata: Record<string, string> = {}) =>
    audit(db, { event, actorAccountId: me(request).id, ip: request.ip, requestId: request.id, metadata });

  async function loadProfile(request: FastifyRequest) {
    const [row] = await app.db.select().from(providerProfiles).where(eq(providerProfiles.accountId, me(request).id));
    if (!row) throw new AppError({ status: 404, code: "PROFILE_NOT_FOUND", title: "Not Found", detail: "This provider has no profile yet" });
    return {
      profile: {
        accountId: row.accountId,
        displayName: me(request).displayName,
        headline: row.headline,
        bio: row.bio,
        department: row.department as Department,
        municipality: row.municipality,
        whatsappE164: row.whatsappE164,
        createdAt: formatLocal(row.createdAt),
        updatedAt: formatLocal(row.updatedAt),
      },
    };
  }

  app.get("/providers/me/profile", { schema: { security, response: { 200: ProfileBody } } }, async (request) => loadProfile(request));

  app.put("/providers/me/profile", { schema: { security, body: ProfileInput, response: { 200: ProfileBody } } }, async (request) => {
    const values = { ...request.body, whatsappE164: request.body.whatsappE164 ?? null };
    await app.db.transaction(async (tx) => {
      await tx
        .insert(providerProfiles)
        .values({ accountId: me(request).id, ...values })
        .onConflictDoUpdate({ target: providerProfiles.accountId, set: { ...values, updatedAt: sql`now()` } });
      await record(tx, request, "provider.profile.updated");
    });
    return loadProfile(request);
  });

  app.get(
    "/providers/me/services",
    { schema: { security, response: { 200: Type.Object({ services: Type.Array(Service) }) } } },
    async (request) => {
      const rows = await app.db
        .select(serviceColumns)
        .from(services)
        .where(eq(services.providerId, me(request).id))
        .orderBy(asc(services.createdAt), asc(services.id));
      return { services: rows.map(serviceBody) };
    },
  );

  app.post(
    "/providers/me/services",
    {
      schema: {
        security,
        body: Type.Object({
          title: Title,
          description: Type.Optional(Description),
          category: Category,
          priceFromCents: Type.Optional(PriceFromCents),
          durationMinutes: Duration,
        }),
        response: { 201: Type.Object({ service: Service }) },
      },
    },
    async (request, reply) => {
      const { title, description, category, priceFromCents, durationMinutes } = request.body;
      const service = await app.db.transaction(async (tx) => {
        await requireProfile(tx, me(request).id);
        const [row] = await tx
          .insert(services)
          .values({ providerId: me(request).id, title, description: description ?? "", category, priceFromCents: priceFromCents ?? null, durationMinutes })
          .returning(serviceColumns);
        await record(tx, request, "provider.service.created", { serviceId: row!.id });
        return row!;
      });
      return reply.code(201).send({ service: serviceBody(service) });
    },
  );

  app.patch(
    "/providers/me/services/:id",
    {
      schema: {
        security,
        params: IdParams,
        body: Type.Object(
          {
            title: Type.Optional(Title),
            description: Type.Optional(Description),
            category: Type.Optional(Category),
            priceFromCents: Type.Optional(PriceFromCents),
            durationMinutes: Type.Optional(Duration),
          },
          { minProperties: 1 },
        ),
        response: { 200: Type.Object({ service: Service }) },
      },
    },
    async (request) => {
      const service = await app.db.transaction(async (tx) => {
        const [row] = await tx
          .update(services)
          .set(request.body)
          .where(and(eq(services.id, request.params.id), eq(services.providerId, me(request).id)))
          .returning(serviceColumns);
        if (!row) throw notFound("No such service for this provider");
        await record(tx, request, "provider.service.updated", { serviceId: row.id });
        return row;
      });
      return { service: serviceBody(service) };
    },
  );

  // Deactivates instead of deleting, so existing bookings keep their service. Repeating it answers 204 without a new audit row.
  app.delete(
    "/providers/me/services/:id",
    { schema: { security, params: IdParams, response: { 204: Type.Null() } } },
    async (request, reply) => {
      await app.db.transaction(async (tx) => {
        const owned = and(eq(services.id, request.params.id), eq(services.providerId, me(request).id));
        const [row] = await tx.select({ active: services.active }).from(services).where(owned).for("update");
        if (!row) throw notFound("No such service for this provider");
        if (!row.active) return;
        await tx.update(services).set({ active: false }).where(owned);
        await record(tx, request, "provider.service.deactivated", { serviceId: request.params.id });
      });
      return reply.code(204).send(null);
    },
  );

  async function loadAvailability(db: Queryable, accountId: string) {
    const rows = await db
      .select({ weekday: availabilityRules.weekday, start: availabilityRules.startTime, end: availabilityRules.endTime })
      .from(availabilityRules)
      .where(eq(availabilityRules.providerId, accountId))
      .orderBy(asc(availabilityRules.weekday), asc(availabilityRules.startTime));
    return { timezone: TIMEZONE, rules: rows.map((r) => ({ weekday: r.weekday, start: formatClock(parseClock(r.start)), end: formatClock(parseClock(r.end)) })) };
  }

  app.get("/providers/me/availability", { schema: { security, response: { 200: AvailabilityBody } } }, async (request) =>
    loadAvailability(app.db, me(request).id),
  );

  // Replaces the weekly rules in one transaction. The profile row is locked first, so concurrent replaces run one after the other.
  app.put(
    "/providers/me/availability",
    { schema: { security, body: Type.Object({ rules: Type.Array(Rule, { maxItems: 100 }) }), response: { 200: AvailabilityBody } } },
    async (request) => {
      const rules = request.body.rules
        .map((r) => ({ weekday: r.weekday, startMinute: parseClock(r.start), endMinute: parseClock(r.end) }))
        .sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute);
      for (const [i, r] of rules.entries()) {
        if (r.endMinute <= r.startMinute) throw unprocessable("INVALID_RULE", "A rule must end after it starts");
        const prev = rules[i - 1];
        if (prev && prev.weekday === r.weekday && r.startMinute < prev.endMinute) throw unprocessable("OVERLAPPING_RULES", "Rules for one weekday must not overlap");
      }
      return app.db.transaction(async (tx) => {
        await requireProfile(tx, me(request).id, true);
        await tx.delete(availabilityRules).where(eq(availabilityRules.providerId, me(request).id));
        if (rules.length > 0) {
          await tx.insert(availabilityRules).values(
            rules.map((r) => ({ providerId: me(request).id, weekday: r.weekday, startTime: formatClock(r.startMinute), endTime: formatClock(r.endMinute) })),
          );
        }
        await record(tx, request, "provider.availability.replaced");
        return loadAvailability(tx, me(request).id);
      });
    },
  );

  // Lists the provider's time off that has not ended yet, earliest first.
  app.get(
    "/providers/me/time-off",
    { schema: { security, response: { 200: Type.Object({ timeOff: Type.Array(TimeOff) }) } } },
    async (request) => {
      const rows = await app.db
        .select(timeOffColumns)
        .from(timeOff)
        .where(and(eq(timeOff.providerId, me(request).id), gt(sql`upper(${timeOff.during})`, new Date())))
        .orderBy(asc(sql`lower(${timeOff.during})`), asc(timeOff.id));
      return { timeOff: rows.map(timeOffBody) };
    },
  );

  app.post(
    "/providers/me/time-off",
    { schema: { security, body: Type.Object({ start: Timestamp, end: Timestamp }), response: { 201: Type.Object({ timeOff: TimeOff }) } } },
    async (request, reply) => {
      const start = new Date(request.body.start);
      const end = new Date(request.body.end);
      if (end <= start) throw unprocessable("INVALID_RANGE", "end must be after start");
      const row = await app.db.transaction(async (tx) => {
        await requireProfile(tx, me(request).id);
        const [created] = await tx
          .insert(timeOff)
          .values({ providerId: me(request).id, during: tstzrangeLiteral(start, end) })
          .returning(timeOffColumns);
        await record(tx, request, "provider.time_off.created", { timeOffId: created!.id });
        return created!;
      });
      return reply.code(201).send({ timeOff: timeOffBody(row) });
    },
  );

  app.delete(
    "/providers/me/time-off/:id",
    { schema: { security, params: IdParams, response: { 204: Type.Null() } } },
    async (request, reply) => {
      await app.db.transaction(async (tx) => {
        const [row] = await tx
          .delete(timeOff)
          .where(and(eq(timeOff.id, request.params.id), eq(timeOff.providerId, me(request).id)))
          .returning({ id: timeOff.id });
        if (!row) throw notFound("No such time off for this provider");
        await record(tx, request, "provider.time_off.deleted", { timeOffId: row.id });
      });
      return reply.code(204).send(null);
    },
  );
};
