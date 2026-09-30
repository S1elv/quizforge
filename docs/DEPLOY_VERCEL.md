# Deployment: Vercel + Neon

## 1. PostgreSQL

Create a Neon PostgreSQL database and copy its pooled connection string into `DATABASE_URL`.

## 2. Vercel

Import the repository as a Vercel project. The repository root is the project root. `vercel.json` already defines the Vite build output, Node.js 22 API function, SPA fallback and five-minute cleanup cron.

Set these production environment variables:

```env
DATABASE_URL=postgresql://...
SETUP_KEY=<at least 32 random characters>
CRON_SECRET=<at least 20 random characters>
APP_URL=https://your-domain.example
NODE_ENV=production
```

Optional:

```env
CORS_ORIGIN=https://an-extra-allowed-origin.example
```

## 3. First account

Open `/setup` after the first deployment and create the first teacher account. After that, rotate or remove `SETUP_KEY` from the Vercel project settings.

## 4. Database

The application bootstraps its idempotent schema automatically. For a new project no manual SQL import is required.

## 5. Checks

Local:

```bash
npm install
npm run check:release
npm run build
```

For local PostgreSQL:

```bash
docker compose up -d postgres
npm run migrate
npm run dev
```
