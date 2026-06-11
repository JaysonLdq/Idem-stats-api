import { buildApp } from './app.js';
import { bumpCoinsBaseline } from './lib/migrate-coins.js';

const port = Number(process.env.PORT || 3000);
const app = buildApp();

// Migration à chaud des soldes existants (one-shot idempotent)
bumpCoinsBaseline();

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[idem-stats-api] listening on :${port}`);
});
