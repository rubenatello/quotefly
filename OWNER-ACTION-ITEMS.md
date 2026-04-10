# QuoteFly — Owner Action Items

## 1. Environment Variables

Add these to your `.env` file (root of the project):

```env
# Required — already should exist
DATABASE_URL=postgresql://...
JWT_SECRET=your-secure-random-secret

# Optional — enables AI-powered Chat-to-Quote via OpenAI
OPENAI_API_KEY=sk-...your-openai-api-key...
OPENAI_MODEL=gpt-4o-mini   # default if omitted
```

### Getting your OpenAI API key
1. Go to https://platform.openai.com/api-keys
2. Create a new secret key
3. Add it to `.env` as `OPENAI_API_KEY`
4. The AI service gracefully falls back to the regex parser if the key is missing

### AI Model Options (set via `OPENAI_MODEL`)
| Model | Cost (input/output per 1M tokens) | Speed | Best For |
|-------|-----------------------------------|-------|----------|
| `gpt-4o-mini` (default) | $0.15 / $0.60 | Fast | Best value — recommended for most plans |
| `gpt-4o` | $2.50 / $10.00 | Medium | Enterprise tier, complex prompts |
| `gpt-4.1-mini` | $0.40 / $1.60 | Fast | Good alternative if available |

## 2. Database Migration

After pulling the latest code:

```bash
npx prisma migrate dev
npx prisma generate
```

## 3. React Router — SPA Fallback

Since we moved to client-side routing with React Router, your web server
must return `index.html` for all non-API routes (SPA fallback).

**Vite dev server** already handles this automatically.

**Production (common setups):**
- **Vercel**: Add a `vercel.json` with `"rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]`
- **Netlify**: Add `_redirects` file: `/* /index.html 200`
- **Nginx**: `try_files $uri $uri/ /index.html;`
- **Fastify static**: Use `@fastify/static` with wildcard fallback

## 4. New App Routes

| Route | View | Description |
|-------|------|-------------|
| `/` | Landing | Marketing homepage |
| `/pricing` | Pricing | Plan comparison |
| `/solutions` | Solutions | Use cases |
| `/about` | About | Team/mission |
| `/app` | Pipeline | Lead pipeline + stats (dashboard home) |
| `/app/build` | Quote Builder | AI Chat-to-Quote + forms + customer creation |
| `/app/quotes` | Quote Desk | Quote editing, line items, send actions |
| `/app/quotes/:id` | Quote Desk | Direct link to specific quote |
| `/app/history` | History | Revision history + communication log |
| `/app/branding` | Branding | Tenant branding settings |
| `/app/admin` | Admin | Admin panel |

## 5. Mobile Bottom Tab Bar

The app now features a fixed bottom navigation bar on mobile (`lg:hidden`) with 5 tabs:
- **Pipeline** → `/app`
- **Build** → `/app/build`
- **Quotes** → `/app/quotes`
- **History** → `/app/history`
- **More** → `/app/admin`

## 6. New UI Component Library

All new views use shared UI primitives from `web/src/components/ui/index.tsx`:
- `Button`, `Input`, `Select`, `Textarea` — all with 44px min touch targets
- `Card`, `CardHeader`, `Badge`, `Alert`, `EmptyState`, `Skeleton`, `Spinner`, `PageHeader`
- Use these for any new UI to maintain consistency

## 7. Analytics

Client-side analytics are buffered and will POST to `/v1/analytics/events` when you implement the endpoint. Currently events log to `console.debug` in development.

## 8. Build & Deploy

```bash
# Frontend build
cd web && npm run build

# Backend type-check
npx tsc --noEmit

# Full dev
npm run dev
```

## 9. Cost Estimation (AI Usage)

Each Chat-to-Quote AI call uses ~500-800 tokens. At `gpt-4o-mini` pricing:
- **Starter plan** (5 AI quotes/month): ~$0.01/month
- **Professional plan** (50 AI quotes/month): ~$0.05/month
- **Enterprise plan** (unlimited): scales with usage, typically <$1/month for most contractors

The existing regex parser continues to work as a free fallback.
