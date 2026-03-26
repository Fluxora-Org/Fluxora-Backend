import { createApp } from './app.js';

const PORT = process.env.PORT ?? 3000;

const app = createApp();

app.listen(PORT, () => {
  console.log(`Fluxora API listening on http://localhost:${PORT}`);
});
