import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { app } from './app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, '../../client/dist');
if (process.env.SERVE_CLIENT === 'true') {
  app.use(express.static(clientDist, { index: 'index.html' }));
  app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  console.log(`QuizForge API listening on http://localhost:${port}`);
});
