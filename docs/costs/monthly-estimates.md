# Estimated Monthly Costs (USD)

## Lean MVP (up to ~25 paying tenants)

- API hosting (Railway/Render starter): $5 to $25
- Managed Postgres (Neon/Supabase starter): $0 to $25
- Twilio phone numbers (dedicated for paid tenants): about $1 to $2 per number/month
- Twilio SMS usage: variable (estimate $20 to $100)
- Stripe: no fixed monthly, transaction fees only
- Object storage for PDFs (optional, R2/S3): $0 to $10

Estimated total lean range: about $30 to $180/month (excluding Stripe transaction fees)

## Growth phase (~100 to 300 tenants)

- API hosting upgraded: $50 to $200
- Managed Postgres upgraded: $50 to $300
- Twilio numbers + usage: $150 to $900+ depending on volume and geographies
- Background jobs/cache (Upstash/Redis): $10 to $50
- Storage + egress: $20 to $100

Estimated total growth range: about $280 to $1,550+/month

## Cost control decisions

- Offer dedicated phone numbers only on paid plans.
- Keep free trials on shared number + tenant keyword routing if needed.
- Generate PDFs on demand and archive cold files.
- Use async workers only when load requires it.
