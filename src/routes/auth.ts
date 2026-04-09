import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { getJwtClaims } from "../lib/auth";

const BCRYPT_ROUNDS = 12;

const SignUpSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  fullName: z.string().min(2),
  companyName: z.string().min(2),
});

const SignInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  // POST /v1/auth/signup
  app.post("/auth/signup", async (request, reply) => {
    const payload = SignUpSchema.parse(request.body);

    const existing = await app.prisma.user.findUnique({
      where: { email: payload.email.toLowerCase() },
    });

    if (existing) {
      return reply.code(409).send({ error: "An account with this email already exists." });
    }

    const passwordHash = await bcrypt.hash(payload.password, BCRYPT_ROUNDS);

    // Generate a URL-safe slug from the company name
    const baseSlug = payload.companyName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    // Ensure slug uniqueness by appending a random suffix if needed
    let slug = baseSlug;
    const conflict = await app.prisma.tenant.findUnique({ where: { slug } });
    if (conflict) {
      slug = `${baseSlug}-${Math.random().toString(36).slice(2, 7)}`;
    }

    const [user, tenant] = await app.prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          email: payload.email.toLowerCase(),
          fullName: payload.fullName,
          passwordHash,
        },
      });

      const newTenant = await tx.tenant.create({
        data: {
          name: payload.companyName,
          slug,
          users: {
            create: { userId: newUser.id, role: "owner" },
          },
        },
      });

      return [newUser, newTenant];
    });

    const token = app.jwt.sign(
      { userId: user.id, tenantId: tenant.id, email: user.email, role: "owner" },
      { expiresIn: "7d" },
    );

    return reply.code(201).send({
      token,
      user: { id: user.id, email: user.email, fullName: user.fullName },
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    });
  });

  // POST /v1/auth/signin
  app.post("/auth/signin", async (request, reply) => {
    const payload = SignInSchema.parse(request.body);

    const user = await app.prisma.user.findUnique({
      where: { email: payload.email.toLowerCase() },
      include: {
        tenantLink: {
          include: { tenant: true },
          orderBy: { createdAt: "asc" },
          take: 1,
        },
      },
    });

    // Constant-time comparison to prevent timing attacks — always run bcrypt even on miss
    const hashToCompare = user?.passwordHash ?? "$2b$12$invalidhashpadding000000000000000000000";
    const valid = await bcrypt.compare(payload.password, hashToCompare);

    if (!user || !valid) {
      return reply.code(401).send({ error: "Invalid email or password." });
    }

    const tenantLink = user.tenantLink[0];
    if (!tenantLink) {
      return reply.code(403).send({ error: "Account has no associated company." });
    }

    const token = app.jwt.sign(
      {
        userId: user.id,
        tenantId: tenantLink.tenantId,
        email: user.email,
        role: tenantLink.role,
      },
      { expiresIn: "7d" },
    );

    return reply.send({
      token,
      user: { id: user.id, email: user.email, fullName: user.fullName },
      tenant: { id: tenantLink.tenant.id, name: tenantLink.tenant.name, slug: tenantLink.tenant.slug },
    });
  });

  // GET /v1/auth/me  (protected)
  app.get("/auth/me", { preHandler: [app.authenticate] }, async (request) => {
    const claims = getJwtClaims(request);

    const user = await app.prisma.user.findUniqueOrThrow({
      where: { id: claims.userId },
      select: { id: true, email: true, fullName: true, createdAt: true },
    });

    const tenant = await app.prisma.tenant.findUniqueOrThrow({
      where: { id: claims.tenantId },
      select: { id: true, name: true, slug: true },
    });

    return { user, tenant, role: claims.role };
  });
};
