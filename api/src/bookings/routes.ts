import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { and, desc, eq, lte, or, sql, type SQL } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { Type } from "typebox";
import { audit, type AuditEvent, type Queryable } from "../audit.js";
import { requireAccount, requireRole } from "../auth/session.js";
import { loadRules, loadTimeOff } from "../catalog/availability.js";
import { computeSlots, horizon } from "../catalog/slots.js";
import { accounts, bookings, providerProfiles, services } from "../db/schema.js";
import { PENDING_HOLD_HOURS, SLOT_STEP_MINUTES } from "../domain.js";
import { AppError, describeError, pgError } from "../errors.js";
import { decodeCursor, page, PAGE_LIMIT_DEFAULT, PageQuery } from "../pagination.js";
import { whatsappLink } from "../providers/whatsapp.js";
import { consume, RATE_LIMITS } from "../rate-limit.js";
import { IdParams, Nullable, Timestamp, Uuid } from "../schemas.js";
import { addMinutes, formatLocal, tstzrangeLiteral } from "../time.js";

const STATUSES = ["pending", "confirmed", "declined", "cancelled", "expired", "completed"] as const;
type Status = (typeof STATUSES)[number];
const StatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("confirmed"),
  Type.Literal("declined"),
  Type.Literal("cancelled"),
  Type.Literal("expired"),
  Type.Literal("completed"),
]);

const Booking = Type.Object({
  id: Uuid,
  reference: Type.String(),
  status: StatusSchema,
  serviceId: Uuid,
  serviceTitle: Type.String(),
  providerId: Uuid,
  clientId: Uuid,
  start: Timestamp,
  end: Timestamp,
  expiresAt: Nullable(Type.String({ format: "date-time" })),
  clientNote: Nullable(Type.String()),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

// The problem body of a 429, as for the auth routes. A response schema drops undeclared members, so all are listed.
const RateLimitedResponse = {
  description: "Too Many Requests",
  content: {
    "application/problem+json": {
      schema: Type.Object({
        type: Type.String(),
        title: Type.String(),
        status: Type.Literal(429),
        detail: Type.String(),
        instance: Type.String(),
        requestId: Type.String(),
        code: Type.Literal("RATE_LIMITED"),
        retryAfterSeconds: Type.Integer({ minimum: 1 }),
      }),
    },
  },
};

// A short code for people to quote, e.g. in the WhatsApp message. It is the start of the id and not guaranteed unique.
export const bookingReference = (id: string) => `CL-${id.slice(0, 8).toUpperCase()}`;

// A pending row whose expires_at has passed is reported as expired whether or not the sweep has marked it yet.
const effectiveStatus = (now: Date) =>
  sql<Status>`CASE WHEN ${bookings.status} = 'pending' AND ${bookings.expiresAt} <= ${now} THEN 'expired' ELSE ${bookings.status}::text END`;

const bookingColumns = (now: Date) => ({
  id: bookings.id,
  status: effectiveStatus(now),
  serviceId: bookings.serviceId,
  serviceTitle: services.title,
  providerId: bookings.providerId,
  clientId: bookings.clientId,
  start: sql`lower(${bookings.during})`.mapWith(bookings.createdAt),
  end: sql`upper(${bookings.during})`.mapWith(bookings.createdAt),
  expiresAt: bookings.expiresAt,
  clientNote: bookings.clientNote,
  createdAt: bookings.createdAt,
  updatedAt: bookings.updatedAt,
  cursorAt: sql<string>`${bookings.createdAt}::text`,
});

type BookingRow = {
  id: string;
  status: Status;
  serviceId: string;
  serviceTitle: string;
  providerId: string;
  clientId: string;
  start: Date;
  end: Date;
  expiresAt: Date | null;
  clientNote: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const bookingBody = (row: BookingRow) => ({
  id: row.id,
  reference: bookingReference(row.id),
  status: row.status,
  serviceId: row.serviceId,
  serviceTitle: row.serviceTitle,
  providerId: row.providerId,
  clientId: row.clientId,
  start: formatLocal(row.start),
  end: formatLocal(row.end),
  expiresAt: row.expiresAt ? formatLocal(row.expiresAt) : null,
  clientNote: row.clientNote,
  createdAt: formatLocal(row.createdAt),
  updatedAt: formatLocal(row.updatedAt),
});

const unprocessable = (code: string, detail: string) => new AppError({ status: 422, code, title: "Unprocessable Content", detail });
const notFound = () => new AppError({ status: 404, code: "NOT_FOUND", title: "Not Found", detail: "No such booking" });
const slotTaken = () => new AppError({ status: 409, code: "SLOT_TAKEN", title: "Conflict", detail: "The slot is no longer free" });
const invalidTransition = (detail: string) => new AppError({ status: 409, code: "INVALID_TRANSITION", title: "Conflict", detail });

// Marks the provider's lapsed pending bookings expired, inside the caller's transaction, so that the exclusion
// constraint stops counting them before a new booking for the provider is inserted. Writes booking.expired for each.
export async function expireLapsed(db: Queryable, providerId: string, now: Date, request: FastifyRequest) {
  const expired = await db
    .update(bookings)
    .set({ status: "expired", updatedAt: now })
    .where(and(eq(bookings.providerId, providerId), eq(bookings.status, "pending"), lte(bookings.expiresAt, now)))
    .returning({ id: bookings.id });
  for (const row of expired) {
    await audit(db, { event: "booking.expired", ip: request.ip, requestId: request.id, metadata: { bookingId: row.id } });
  }
}

// The message prefilled in the provider's wa.me link after a booking, with the reference the provider can look up.
const bookingMessage = (displayName: string, serviceTitle: string, start: Date, reference: string) =>
  `Hola ${displayName}, reservé "${serviceTitle}" para el ${formatLocal(start).slice(0, 16).replace("T", " ")} (hora de El Salvador). Referencia: ${reference}.`;

type Verb = "confirm" | "decline" | "cancel" | "complete";
const TARGET: Record<Verb, Status> = { confirm: "confirmed", decline: "declined", cancel: "cancelled", complete: "completed" };

export const bookingRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // Responses carry booking data, so no cache may keep them. Error responses included.
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("cache-control", "no-store");
  });

  const security = [{ cookieAuth: [] }];

  // The limiter fails open, as for the auth routes: an error is logged and the request continues as if it were allowed.
  async function limitBookings(request: FastifyRequest) {
    const rule = RATE_LIMITS.BOOKING_CLIENT;
    let result: Awaited<ReturnType<typeof consume>> | undefined;
    try {
      result = await consume(app.db, `booking:account:${request.account!.id}`, rule);
    } catch (err) {
      request.log.error({ err: describeError(err) }, "rate limiter failed");
      return;
    }
    if (result.allowed) return;
    // Written once per account and window: audit rows cannot be deleted, so rejections must not add rows.
    if (result.count === rule.limit + 1) {
      await audit(app.db, { event: "booking.rate_limited", actorAccountId: request.account!.id, ip: request.ip, requestId: request.id, metadata: { scope: "booking-client" } });
    }
    throw new AppError({
      status: 429,
      code: "RATE_LIMITED",
      title: "Too Many Requests",
      detail: "Too many attempts. Try again later.",
      extensions: { retryAfterSeconds: result.retryAfterSeconds },
      headers: { "retry-after": String(result.retryAfterSeconds) },
    });
  }

  async function loadBooking(db: Queryable, id: string, now: Date) {
    const [row] = await db.select(bookingColumns(now)).from(bookings).innerJoin(services, eq(services.id, bookings.serviceId)).where(eq(bookings.id, id));
    return row;
  }

  app.post(
    "/bookings",
    {
      preHandler: requireRole("client"),
      schema: {
        security,
        body: Type.Object({ serviceId: Uuid, start: Timestamp, clientNote: Type.Optional(Type.String({ maxLength: 500 })) }),
        response: { 201: Type.Object({ booking: Booking, whatsappLink: Nullable(Type.String()) }), 429: RateLimitedResponse },
      },
    },
    async (request, reply) => {
      await limitBookings(request);
      const client = request.account!;
      const start = new Date(request.body.start);

      const [service] = await app.db
        .select({
          id: services.id,
          title: services.title,
          durationMinutes: services.durationMinutes,
          providerId: services.providerId,
          displayName: accounts.displayName,
          whatsappE164: providerProfiles.whatsappE164,
        })
        .from(services)
        .innerJoin(providerProfiles, eq(providerProfiles.accountId, services.providerId))
        .innerJoin(accounts, eq(accounts.id, services.providerId))
        .where(and(eq(services.id, request.body.serviceId), eq(services.active, true)));
      if (!service) throw new AppError({ status: 404, code: "NOT_FOUND", title: "Not Found", detail: "No such active service" });

      // The offset is a whole number of hours, so the local half-hour grid is the UTC one.
      if (start.getTime() % (SLOT_STEP_MINUTES * 60_000) !== 0) throw unprocessable("START_MISALIGNED", "start must be on the half-hour");
      const now = new Date();
      const { earliest, latest } = horizon(now);
      if (start < earliest || start > latest) throw unprocessable("OUTSIDE_HORIZON", "start must be between one hour and 60 days from now");
      const end = addMinutes(start, service.durationMinutes);
      const expiresAt = new Date(Math.min(now.getTime() + PENDING_HOLD_HOURS * 3_600_000, start.getTime()));

      const attempt = () =>
        app.db.transaction(async (tx) => {
          await expireLapsed(tx, service.providerId, now, request);
          const rules = await loadRules(tx, service.providerId);
          const inRules = computeSlots({ rules, blocked: [], durationMinutes: service.durationMinutes, from: start, to: addMinutes(start, 1), now });
          if (inRules.length === 0) throw unprocessable("OUTSIDE_AVAILABILITY", "The provider is not available at that time");
          if ((await loadTimeOff(tx, service.providerId, start, end)).length > 0) throw unprocessable("TIME_OFF", "The provider is off at that time");
          const [created] = await tx
            .insert(bookings)
            .values({
              providerId: service.providerId,
              clientId: client.id,
              serviceId: service.id,
              during: tstzrangeLiteral(start, end),
              status: "pending",
              expiresAt,
              clientNote: request.body.clientNote ?? null,
            })
            .returning({ id: bookings.id });
          await audit(tx, {
            event: "booking.created",
            actorAccountId: client.id,
            ip: request.ip,
            requestId: request.id,
            metadata: { bookingId: created!.id, serviceId: service.id, providerId: service.providerId },
          });
          return created!.id;
        });

      // An overlapping insert fails with 23P01, or with 40P01 when concurrent inserters wait on each other; a deadlock
      // is retried once, since the retry usually meets the committed winner and fails with 23P01.
      let id: string | undefined;
      for (let tries = 0; id === undefined; tries++) {
        try {
          id = await attempt();
        } catch (err) {
          const { code, constraint } = pgError(err);
          if (code === "23P01" && constraint === "bookings_no_provider_overlap") throw slotTaken();
          if (code === "40P01") {
            if (tries === 0) continue;
            throw slotTaken();
          }
          throw err;
        }
      }

      const booking = bookingBody((await loadBooking(app.db, id, now))!);
      const link = service.whatsappE164 ? whatsappLink(service.whatsappE164, bookingMessage(service.displayName, service.title, start, booking.reference)) : null;
      return reply.code(201).send({ booking, whatsappLink: link });
    },
  );

  app.get(
    "/bookings",
    {
      preHandler: requireAccount,
      schema: {
        security,
        querystring: Type.Object({ status: Type.Optional(StatusSchema), ...PageQuery }),
        response: { 200: Type.Object({ bookings: Type.Array(Booking), nextCursor: Nullable(Type.String()) }) },
      },
    },
    async (request) => {
      const me = request.account!.id;
      const now = new Date();
      const limit = request.query.limit ?? PAGE_LIMIT_DEFAULT;
      const filters: (SQL | undefined)[] = [or(eq(bookings.clientId, me), eq(bookings.providerId, me))];
      if (request.query.status) filters.push(sql`${effectiveStatus(now)} = ${request.query.status}`);
      if (request.query.cursor) {
        const after = decodeCursor(request.query.cursor);
        filters.push(sql`(${bookings.createdAt}, ${bookings.id}) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`);
      }
      const rows = await app.db
        .select(bookingColumns(now))
        .from(bookings)
        .innerJoin(services, eq(services.id, bookings.serviceId))
        .where(and(...filters))
        .orderBy(desc(bookings.createdAt), desc(bookings.id))
        .limit(limit + 1);
      const { items, nextCursor } = page(
        rows.map((r) => ({ ...r, cursor: { createdAt: r.cursorAt, id: r.id } })),
        limit,
      );
      return { bookings: items.map(bookingBody), nextCursor };
    },
  );

  // Anyone but the two parties gets 404, so the route does not reveal which booking ids exist.
  app.get(
    "/bookings/:id",
    { preHandler: requireAccount, schema: { security, params: IdParams, response: { 200: Type.Object({ booking: Booking }) } } },
    async (request) => {
      const row = await loadBooking(app.db, request.params.id, new Date());
      const me = request.account!.id;
      if (!row || (row.clientId !== me && row.providerId !== me)) throw notFound();
      return { booking: bookingBody(row) };
    },
  );

  // confirm and decline: provider, from pending. cancel: either party, from pending or confirmed, a client only before
  // the start. complete: provider, from confirmed, from the start time on.
  function check(verb: Verb, status: Status, isProvider: boolean, start: Date, now: Date) {
    if (verb !== "cancel" && !isProvider) throw new AppError({ status: 403, code: "FORBIDDEN", title: "Forbidden", detail: `Only the provider can ${verb} a booking` });
    switch (verb) {
      case "confirm":
      case "decline":
        if (status !== "pending") throw invalidTransition(`A ${status} booking cannot be ${TARGET[verb]}`);
        return;
      case "cancel":
        if (status !== "pending" && status !== "confirmed") throw invalidTransition(`A ${status} booking cannot be cancelled`);
        if (!isProvider && now >= start) throw invalidTransition("A client can cancel only before the start time");
        return;
      case "complete":
        if (status !== "confirmed") throw invalidTransition(`A ${status} booking cannot be completed`);
        if (now < start) throw invalidTransition("A booking can be completed only after its start time");
    }
  }

  for (const verb of ["confirm", "decline", "cancel", "complete"] as const) {
    app.post(
      `/bookings/:id/${verb}`,
      { preHandler: requireAccount, schema: { security, params: IdParams, response: { 200: Type.Object({ booking: Booking }) } } },
      async (request) => {
        const me = request.account!.id;
        const now = new Date();
        const booking = await app.db.transaction(async (tx) => {
          // The row lock makes concurrent transitions of one booking run one after the other.
          const [locked] = await tx
            .select({ id: bookings.id, status: effectiveStatus(now), clientId: bookings.clientId, providerId: bookings.providerId, start: sql`lower(${bookings.during})`.mapWith(bookings.createdAt) })
            .from(bookings)
            .where(and(eq(bookings.id, request.params.id), or(eq(bookings.clientId, me), eq(bookings.providerId, me))))
            .for("update");
          if (!locked) throw notFound();
          check(verb, locked.status, locked.providerId === me, locked.start, now);
          await tx.update(bookings).set({ status: TARGET[verb], updatedAt: now }).where(eq(bookings.id, locked.id));
          await audit(tx, { event: `booking.${TARGET[verb]}` as AuditEvent, actorAccountId: me, ip: request.ip, requestId: request.id, metadata: { bookingId: locked.id } });
          return (await loadBooking(tx, locked.id, now))!;
        });
        return { booking: bookingBody(booking) };
      },
    );
  }
};
