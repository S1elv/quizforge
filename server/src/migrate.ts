import 'dotenv/config';
import { ensureSchema } from './db.js';

await ensureSchema();
console.log('Database schema is ready.');
