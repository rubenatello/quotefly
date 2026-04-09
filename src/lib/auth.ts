import { FastifyRequest } from "fastify";
import { z } from "zod";

const JwtClaimsSchema = z.object({
  userId: z.string().min(1),
  tenantId: z.string().min(1),
  email: z.string().email(),
  role: z.string().min(1),
});

export type JwtClaims = z.infer<typeof JwtClaimsSchema>;

export function getJwtClaims(request: FastifyRequest): JwtClaims {
  return JwtClaimsSchema.parse(request.user);
}
