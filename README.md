# idem-stats-api

Backend de **idem-stats** — Node.js + Express + Prisma + Postgres. Sert l'app mobile Kotlin, la web app et l'extension Chrome.

## Stack
Node 20 (ES modules), Express, Prisma + Postgres, Zod (validation), JWT + bcrypt, Vitest + supertest. Docker multi-stage + docker-compose (app / db / traefik).

## Boot rapide

```bash
cp .env.example .env
docker compose up --build
# API : http://localhost:3000 (ou http://api.idem.localhost via Traefik)
```

## Endpoints

- `POST /auth/register {pseudo,password}` → `{token,user}`
- `POST /auth/login {pseudo,password}` → `{token,user}`
- `GET /me`
- `POST /matches {game, opponentPseudo?}` → match `active` (avec opponent) ou `pending` + `{code}`
- `POST /matches/join {code}`
- `PATCH /matches/:id/score {scoreP1,scoreP2,source}`
- `POST /matches/:id/finish`
- `GET /matches?scope=me|all&game=`
- `GET /matches/:id`
- `GET /leaderboard?game=` → `[{user,wins,losses,played,winrate}]` trié par victoires

## Tests

```bash
npm test
```
