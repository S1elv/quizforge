import crypto from 'node:crypto';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import express from 'express';
import { z } from 'zod';
import { sql, ensureSchema } from './db.js';
import { authenticateTeacher, createSession, destroySession, requireTeacher, type AuthRequest } from './auth.js';
import { newId, createOpaqueToken, hashToken, makeShareCode } from './ids.js';
import { defaultSettings, normalizeQuestion, normalizeTest } from './normalize.js';
import { gradeQuestion } from './grading.js';
import type { QuestionInput, TestSnapshot } from './types.js';

if (process.env.NODE_ENV === 'production') {
  const missing = ['DATABASE_URL','SETUP_KEY','APP_URL','CRON_SECRET'].filter(name => !process.env[name]);
  if (missing.length) throw new Error(`В production не заданы обязательные переменные: ${missing.join(', ')}`);
  if (!String(process.env.APP_URL).startsWith('https://')) throw new Error('APP_URL в production должен использовать HTTPS.');
  if (String(process.env.SETUP_KEY).length < 32) throw new Error('SETUP_KEY должен содержать минимум 32 символа.');
  if (String(process.env.CRON_SECRET).length < 20) throw new Error('CRON_SECRET должен содержать минимум 20 символов.');
}

export const app = express();
app.set('trust proxy', 1);
app.use(cookieParser());
app.use(helmet(process.env.NODE_ENV === 'production' ? {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"], baseUri: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], formAction: ["'self'"],
      scriptSrc: ["'self'"], styleSrc: ["'self'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:', 'blob:'], connectSrc: ["'self'", 'wss:', 'ws:'], upgradeInsecureRequests: []
    }
  }, crossOriginEmbedderPolicy: false
} : { contentSecurityPolicy:false, crossOriginEmbedderPolicy:false }));
const configuredOrigins = [
  process.env.APP_URL?.replace(/\/$/, ''),
  process.env.CORS_ORIGIN?.replace(/\/$/, ''),
  process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL.replace(/\/$/, '')}` : undefined,
].filter((value): value is string => Boolean(value));
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || configuredOrigins.length === 0 || configuredOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Недопустимый источник запроса.'));
  },
  credentials: true,
}));
app.use(express.json({ limit: '4mb' }));
app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control','no-store'); res.setHeader('Vary','Origin'); next(); });
const loginLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false, message: { message: 'Слишком много попыток входа. Повторите позже.' } });
const setupLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false, message: { message: 'Слишком много запросов первичной настройки.' } });
const joinLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false, message: { message: 'Слишком много запросов. Повторите позже.' } });
const attemptLimiter = rateLimit({ windowMs: 60 * 1000, limit: 240, standardHeaders: 'draft-8', legacyHeaders: false, message: { message: 'Слишком много действий за короткое время.' } });

const questionTypes = ['single_choice','multiple_choice','true_false','fill_blank','matching','short_text','long_text','ordering','numeric','code'] as const;
const questionSchema = z.object({ id: z.string().optional(), position: z.number().int().nonnegative(), type: z.enum(questionTypes), prompt: z.string().min(1).max(10000), points: z.number().min(0).max(1000), data: z.record(z.any()) });
const testSchema = z.object({ title: z.string().min(1).max(160), description: z.string().max(4000).optional().default(''), durationSeconds: z.number().int().min(0).max(86400), settings: z.record(z.any()).optional().default({}), questions: z.array(questionSchema).max(500) });

let ready: Promise<void> | null = null;
async function dbReady() { ready ??= ensureSchema(); await ready; }
app.use(async (_req, _res, next) => { try { await dbReady(); next(); } catch (error) { next(error); } });

function validateOrigin(req: express.Request, res: express.Response) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return true;
  const origin = req.get('origin');
  if (process.env.NODE_ENV === 'production') {
    if (!origin || (configuredOrigins.length > 0 && !configuredOrigins.includes(origin))) {
      res.status(403).json({ message: 'Недопустимый источник запроса.' });
      return false;
    }
    return true;
  }
  if (origin && configuredOrigins.length > 0 && !configuredOrigins.includes(origin)) {
    res.status(403).json({ message: 'Недопустимый источник запроса.' });
    return false;
  }
  return true;
}
app.use((req, res, next) => validateOrigin(req, res) ? next() : undefined);

function json(value: any) { return value == null ? null : value; }
function publicQuestion(question: any) {
  const data = structuredClone(question.data_json ?? {});
  delete data.correctOptionId;
  delete data.correctOptionIds;
  delete data.correct;
  delete data.accepted;
  delete data.tolerance;
  delete data.correctOrderIds;
  delete data.rubric;
  if (question.type === 'matching') data.pairs = Array.isArray(data.pairs) ? data.pairs.map((p: any) => ({ id: p.id, left: p.left, right: p.right })) : [];
  if (question.type === 'ordering') data.items = Array.isArray(data.items) ? data.items.map((p: any) => ({ id: p.id, text: p.text })) : [];
  if (question.type === 'single_choice' || question.type === 'multiple_choice') data.options = Array.isArray(data.options) ? data.options.filter((o:any) => String(o?.text ?? '').trim()) : [];
  return { id: question.id, position: question.position, type: question.type, prompt: question.prompt, points: Number(question.points), data };
}

async function getTest(testId: string, teacherId: string) {
  const rows = await sql`SELECT * FROM tests WHERE id = ${testId} AND teacher_id = ${teacherId} LIMIT 1`;
  const t = rows[0] as any;
  if (!t) return null;
  const qs = await sql`SELECT * FROM questions WHERE test_id = ${testId} ORDER BY position ASC`;
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    durationSeconds: t.duration_seconds,
    settings: { ...defaultSettings, ...(t.settings_json ?? {}) },
    published: Boolean(t.published),
    shareCode: t.share_code,
    currentVersion: Number(t.current_version),
    publishedVersion: t.published_version == null ? null : Number(t.published_version),
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    questions: qs.map((q: any) => ({ id:q.id, position:q.position, type:q.type, prompt:q.prompt, points:Number(q.points), data:q.data_json ?? {} })),
  };
}

function versionInsertQuery(versionId: string, testId: string, snapshot: TestSnapshot, versionNumber: number) {
  return sql`INSERT INTO test_versions (id, test_id, version_number, snapshot_json) VALUES (${versionId}, ${testId}, ${versionNumber}, ${JSON.stringify(snapshot)}::jsonb)`;
}

async function createVersion(testId: string, snapshot: TestSnapshot, versionNumber: number) {
  const versionId = newId();
  await versionInsertQuery(versionId, testId, snapshot, versionNumber);
  return versionId;
}

function validatePublish(snapshot: TestSnapshot): string | null {
  if (!snapshot.title.trim()) return 'Укажите название теста.';
  if (snapshot.questions.length === 0) return 'Добавьте хотя бы один вопрос.';
  for (let i = 0; i < snapshot.questions.length; i++) {
    const q = snapshot.questions[i];
    if (!q.prompt.trim()) return `Вопрос ${i + 1}: текст вопроса пуст.`;
    if (!Number.isFinite(q.points) || q.points <= 0) return `Вопрос ${i + 1}: баллы должны быть больше нуля.`;
    if (q.type === 'single_choice' || q.type === 'multiple_choice') {
      const options = (q.data.options ?? []) as any[];
      const usable = options.filter(o => String(o?.text ?? '').trim());
      if (usable.length < 2) return `Вопрос ${i + 1}: нужно минимум два непустых варианта.`;
      const optionIds = usable.map(o => String(o.id));
      if (optionIds.some(id => !id) || new Set(optionIds).size !== optionIds.length) return `Вопрос ${i + 1}: идентификаторы вариантов должны быть уникальными.`;
      const ids = new Set(optionIds);
      if (q.type === 'single_choice') {
        if (!q.data.correctOptionId || !ids.has(String(q.data.correctOptionId))) return `Вопрос ${i + 1}: выберите правильный вариант.`;
      } else {
        const correct = Array.isArray(q.data.correctOptionIds) ? q.data.correctOptionIds.map(String) : [];
        if (!correct.length) return `Вопрос ${i + 1}: укажите хотя бы один правильный вариант.`;
        if (new Set(correct).size !== correct.length) return `Вопрос ${i + 1}: правильные варианты не должны повторяться.`;
        if (correct.some(id => !ids.has(id))) return `Вопрос ${i + 1}: один из правильных вариантов больше не существует.`;
      }
    }
    if (q.type === 'fill_blank') {
      const accepted = Array.isArray(q.data.accepted) ? q.data.accepted.map((x: unknown) => String(x).trim()).filter(Boolean) : [];
      if (!accepted.length) return `Вопрос ${i + 1}: укажите допустимые ответы.`;
    }
    if (q.type === 'matching') {
      const pairs = Array.isArray(q.data.pairs) ? q.data.pairs : [];
      if (pairs.length < 2) return `Вопрос ${i + 1}: добавьте минимум две пары соответствий.`;
      if (pairs.some((p: any) => !String(p?.left ?? '').trim() || !String(p?.right ?? '').trim())) return `Вопрос ${i + 1}: все элементы соответствия должны быть заполнены.`;
      const pairIds = pairs.map((p:any)=>String(p.id));
      if (pairIds.some(id=>!id) || new Set(pairIds).size!==pairIds.length) return `Вопрос ${i + 1}: идентификаторы пар должны быть уникальными.`;
      const rights = pairs.map((p: any) => String(p.right).trim().toLocaleLowerCase('ru-RU'));
      if (new Set(rights).size !== rights.length) return `Вопрос ${i + 1}: правые элементы соответствия должны быть уникальными.`;
    }
    if (q.type === 'ordering') {
      const items = Array.isArray(q.data.items) ? q.data.items : [];
      if (items.length < 2) return `Вопрос ${i + 1}: добавьте минимум два элемента для сортировки.`;
      if (items.some((item: any) => !String(item?.text ?? '').trim())) return `Вопрос ${i + 1}: все элементы порядка должны быть заполнены.`;
      const itemIds = items.map((item:any)=>String(item.id));
      if (itemIds.some(id=>!id) || new Set(itemIds).size!==itemIds.length) return `Вопрос ${i + 1}: идентификаторы элементов должны быть уникальными.`;
    }
    if (q.type === 'numeric') {
      if (!Number.isFinite(Number(q.data.correct))) return `Вопрос ${i + 1}: укажите корректное число.`;
      if (!Number.isFinite(Number(q.data.tolerance)) || Number(q.data.tolerance) < 0) return `Вопрос ${i + 1}: допуск должен быть неотрицательным числом.`;
    }
  }
  return null;
}

async function getAttemptByToken(id: string, token: string) {
  const rows = await sql`SELECT * FROM attempts WHERE id = ${id} AND access_token_hash = ${hashToken(token)} LIMIT 1`;
  return rows[0] as any;
}

async function finalizeAttempt(a: any, snapshot: TestSnapshot, status: 'submitted' | 'expired') {
  const answers = await sql`SELECT question_id,points,review_status FROM attempt_answers WHERE attempt_id=${a.id}`;
  const earned = answers.reduce((sum:number,r:any)=>sum+(r.points == null ? 0 : Number(r.points)),0);
  const max = Number(a.max_score ?? snapshot.questions.reduce((sum,q)=>sum+q.points,0));
  const pendingManual = answers.some((r:any)=>r.review_status==='pending');
  const reviewStatus = pendingManual ? 'unreviewed' : 'reviewed';
  await sql`UPDATE attempts SET status=${status},submitted_at=NOW(),score=${earned},max_score=${max},review_status=${reviewStatus},last_seen_at=NOW() WHERE id=${a.id}`;
  return { score:earned, maxScore:max, pendingManual, reviewStatus };
}

app.get('/api/health', async (_req, res) => res.json({ ok: true, service: 'quizforge', time: new Date().toISOString() }));

app.get('/api/setup/status', async (_req, res) => {
  const rows = await sql`SELECT COUNT(*)::int AS count FROM teachers`;
  res.json({ needsSetup: Number((rows[0] as any).count) === 0, setupConfigured: Boolean(process.env.SETUP_KEY) });
});

app.post('/api/setup/teacher', setupLimiter, async (req, res) => {
  const body = z.object({ setupKey:z.string().min(16).max(512), username:z.string().min(3).max(64), password:z.string().min(10).max(200), displayName:z.string().min(1).max(120) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ message:'Проверьте данные формы. Ключ должен содержать минимум 16 символов, пароль — минимум 10.' });
  const expectedKey = process.env.SETUP_KEY || '';
  const suppliedKey = body.data.setupKey;
  const validKey = expectedKey.length === suppliedKey.length && expectedKey.length > 0 && crypto.timingSafeEqual(Buffer.from(expectedKey), Buffer.from(suppliedKey));
  if (!validKey) return res.status(403).json({ message:'Неверный ключ первоначальной настройки.' });
  const { hashPassword } = await import('./auth.js');
  const username = body.data.username.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,64}$/.test(username)) return res.status(400).json({ message:'Логин может содержать только латинские буквы, цифры, точку, подчёркивание и дефис.' });
  const teacher = { id:newId(), username, displayName:body.data.displayName.replace(/\s+/g,' ').trim() };
  const setupResult = await sql.transaction([
    sql`SELECT pg_advisory_xact_lock(48270193)`,
    sql`INSERT INTO teachers (id, username, password_hash, display_name)
        SELECT ${teacher.id}, ${teacher.username}, ${hashPassword(body.data.password)}, ${teacher.displayName}
        WHERE NOT EXISTS (SELECT 1 FROM teachers)
        RETURNING id`,
  ]);
  if (!(setupResult[1] as any[])[0]) return res.status(409).json({ message:'Первоначальная настройка уже выполнена.' });
  await createSession(teacher, res);
  res.status(201).json({ user: teacher });
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const body = z.object({ username:z.string().min(1).max(64), password:z.string().min(1).max(200) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ message:'Введите логин и пароль.' });
  const teacher = await authenticateTeacher(body.data.username, body.data.password);
  if (!teacher) return res.status(401).json({ message:'Неверный логин или пароль.' });
  await createSession(teacher, res);
  res.json({ user: teacher });
});

app.post('/api/auth/logout', requireTeacher, async (req, res) => { await destroySession(req, res); res.status(204).end(); });
app.get('/api/auth/me', requireTeacher, async (req:AuthRequest,res) => res.json({ user:req.teacher }));

app.get('/api/tests', requireTeacher, async (req:AuthRequest,res) => {
  const rows = await sql`
    SELECT t.id, t.title, t.description, t.duration_seconds, t.published, t.share_code, t.current_version, t.published_version, t.updated_at,
      (SELECT COUNT(*)::int FROM questions q WHERE q.test_id=t.id) AS question_count,
      (SELECT COUNT(*)::int FROM attempts a WHERE a.test_id=t.id) AS attempt_count,
      (SELECT COUNT(*)::int FROM attempts a WHERE a.test_id=t.id AND a.status='active') AS active_count,
      (SELECT COUNT(*)::int FROM attempts a WHERE a.test_id=t.id AND a.warning_count>0) AS warning_attempt_count
    FROM tests t WHERE t.teacher_id=${req.teacher!.id} ORDER BY t.updated_at DESC`;
  res.json(rows.map((t:any)=>({ id:t.id,title:t.title,description:t.description,durationSeconds:t.duration_seconds,published:Boolean(t.published),shareCode:t.share_code,currentVersion:Number(t.current_version),publishedVersion:t.published_version==null?null:Number(t.published_version),updatedAt:t.updated_at,questionCount:Number(t.question_count),attemptCount:Number(t.attempt_count),activeCount:Number(t.active_count),warningAttemptCount:Number(t.warning_attempt_count) })));
});

app.get('/api/tests/:id', requireTeacher, async (req:AuthRequest,res) => {
  const test = await getTest(req.params.id, req.teacher!.id);
  if (!test) return res.status(404).json({ message:'Тест не найден.' });
  res.json(test);
});

app.post('/api/tests', requireTeacher, async (req:AuthRequest,res) => {
  const parsed = testSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message:'Некорректные данные теста.' });
  const snapshot = normalizeTest(parsed.data) as TestSnapshot;
  if (!snapshot.title) return res.status(400).json({ message:'Название теста обязательно.' });
  const id = newId();
  const versionId = newId();
  const queries = [
    sql`INSERT INTO tests (id, teacher_id, title, description, duration_seconds, settings_json, current_version, published_version) VALUES (${id},${req.teacher!.id},${snapshot.title},${snapshot.description},${snapshot.durationSeconds},${JSON.stringify(snapshot.settings)}::jsonb,1,NULL)`,
    versionInsertQuery(versionId, id, snapshot, 1),
    ...snapshot.questions.map((question, position) => sql`INSERT INTO questions (id,test_id,position,type,prompt,points,data_json) VALUES (${question.id},${id},${position},${question.type},${question.prompt},${question.points},${JSON.stringify(question.data)}::jsonb)`),
  ];
  await sql.transaction(queries);
  res.status(201).json(await getTest(id, req.teacher!.id));
});

app.put('/api/tests/:id', requireTeacher, async (req:AuthRequest,res) => {
  const parsed = testSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message:'Некорректные данные теста.' });
  const test = await getTest(req.params.id, req.teacher!.id);
  if (!test) return res.status(404).json({ message:'Тест не найден.' });
  const snapshot = normalizeTest(parsed.data) as TestSnapshot;
  const nextVersion = Number(test.currentVersion) + 1;
  const versionId = newId();
  const queries = [
    sql`UPDATE tests SET title=${snapshot.title}, description=${snapshot.description}, duration_seconds=${snapshot.durationSeconds}, settings_json=${JSON.stringify(snapshot.settings)}::jsonb, current_version=${nextVersion}, updated_at=NOW() WHERE id=${req.params.id} AND teacher_id=${req.teacher!.id}`,
    sql`DELETE FROM questions WHERE test_id=${req.params.id}`,
    ...snapshot.questions.map((question, position) => sql`INSERT INTO questions (id,test_id,position,type,prompt,points,data_json) VALUES (${question.id},${req.params.id},${position},${question.type},${question.prompt},${question.points},${JSON.stringify(question.data)}::jsonb)`),
    versionInsertQuery(versionId, req.params.id, snapshot, nextVersion),
  ];
  await sql.transaction(queries);
  res.json(await getTest(req.params.id, req.teacher!.id));
});

app.post('/api/tests/:id/publish', requireTeacher, async (req:AuthRequest,res) => {
  const test = await getTest(req.params.id, req.teacher!.id);
  if (!test) return res.status(404).json({ message:'Тест не найден.' });
  const publish = req.body?.published !== false;
  if (!publish) {
    await sql`UPDATE tests SET published=FALSE, published_version=NULL, share_code=NULL, updated_at=NOW() WHERE id=${req.params.id} AND teacher_id=${req.teacher!.id}`;
    return res.json({ published:false, shareCode:null, publishedVersion:null });
  }
  const snapshot = { title:test.title, description:test.description, durationSeconds:test.durationSeconds, settings:test.settings, questions:test.questions } as TestSnapshot;
  const validation = validatePublish(snapshot);
  if (validation) return res.status(400).json({ message:validation });
  let code = test.shareCode;
  if (!code) code = await makeShareCode(async candidate => (await sql`SELECT 1 FROM tests WHERE share_code=${candidate} LIMIT 1`).length > 0);
  await sql`UPDATE tests SET published=TRUE, published_version=${test.currentVersion}, share_code=${code}, updated_at=NOW() WHERE id=${req.params.id} AND teacher_id=${req.teacher!.id}`;
  res.json({ published:true, shareCode:code, publishedVersion:test.currentVersion });
});

app.post('/api/tests/:id/duplicate', requireTeacher, async (req:AuthRequest,res) => {
  const original = await getTest(req.params.id, req.teacher!.id);
  if (!original) return res.status(404).json({ message:'Тест не найден.' });
  const id = newId();
  const snapshot = { title:`${original.title} — копия`, description:original.description, durationSeconds:original.durationSeconds, settings:original.settings, questions:original.questions.map((q, i) => normalizeQuestion({ ...q, id: undefined }, i)) } as TestSnapshot;
  const versionId = newId();
  const queries = [
    sql`INSERT INTO tests (id, teacher_id, title, description, duration_seconds, settings_json, current_version, published_version) VALUES (${id},${req.teacher!.id},${snapshot.title},${snapshot.description},${snapshot.durationSeconds},${JSON.stringify(snapshot.settings)}::jsonb,1,NULL)`,
    versionInsertQuery(versionId, id, snapshot, 1),
    ...snapshot.questions.map((q, position) => sql`INSERT INTO questions (id,test_id,position,type,prompt,points,data_json) VALUES (${q.id},${id},${position},${q.type},${q.prompt},${q.points},${JSON.stringify(q.data)}::jsonb)`),
  ];
  await sql.transaction(queries);
  res.status(201).json(await getTest(id, req.teacher!.id));
});

app.delete('/api/tests/:id', requireTeacher, async (req:AuthRequest,res) => {
  const rows = await sql`SELECT id,published,(SELECT COUNT(*)::int FROM attempts a WHERE a.test_id=tests.id) AS attempts FROM tests WHERE id=${req.params.id} AND teacher_id=${req.teacher!.id} LIMIT 1`;
  const test = rows[0] as any;
  if (!test) return res.status(404).json({ message:'Тест не найден.' });
  if (Number(test.attempts) > 0) return res.status(409).json({ message:'Тест нельзя удалить: по нему уже есть попытки. Закройте публикацию и сохраните историю.' });
  await sql`DELETE FROM tests WHERE id=${req.params.id} AND teacher_id=${req.teacher!.id}`;
  res.status(204).end();
});

app.get('/api/question-bank', requireTeacher, async (req:AuthRequest,res) => {
  const rows = await sql`
    SELECT q.id,q.test_id,t.title AS test_title,q.type,q.prompt,q.points,q.data_json
    FROM questions q JOIN tests t ON t.id=q.test_id
    WHERE t.teacher_id=${req.teacher!.id}
    ORDER BY t.updated_at DESC,q.position ASC`;
  res.json(rows.map((q:any)=>({id:q.id,testId:q.test_id,testTitle:q.test_title,type:q.type,prompt:q.prompt,points:Number(q.points),data:q.data_json ?? {}})));
});

app.post('/api/tests/:id/import', requireTeacher, async (req:AuthRequest,res) => {
  const target = await getTest(req.params.id, req.teacher!.id);
  if (!target) return res.status(404).json({ message:'Тест не найден.' });
  const ids = z.array(z.string()).max(200).safeParse(req.body?.questionIds);
  if (!ids.success || ids.data.length === 0) return res.status(400).json({ message:'Выберите хотя бы один вопрос.' });
  let position = target.questions.length;
  for (const sourceId of ids.data) {
    const rows = await sql`SELECT q.id,q.type,q.prompt,q.points,q.data_json,t.teacher_id FROM questions q JOIN tests t ON t.id=q.test_id WHERE q.id=${sourceId} AND t.teacher_id=${req.teacher!.id} LIMIT 1`;
    const q = rows[0] as any;
    if (!q) continue;
    const question = normalizeQuestion({id:undefined,type:q.type,prompt:q.prompt,points:Number(q.points),position,data:q.data_json ?? {}}, position);
    await sql`INSERT INTO questions (id,test_id,position,type,prompt,points,data_json) VALUES (${question.id},${target.id},${position},${question.type},${question.prompt},${question.points},${JSON.stringify(question.data)}::jsonb)`;
    position += 1;
  }
  const updated = await getTest(target.id, req.teacher!.id);
  const snapshot = { title:updated!.title, description:updated!.description, durationSeconds:updated!.durationSeconds, settings:updated!.settings, questions:updated!.questions } as TestSnapshot;
  const nextVersion = Number(updated!.currentVersion) + 1;
  await sql`UPDATE tests SET current_version=${nextVersion}, updated_at=NOW() WHERE id=${target.id}`;
  await createVersion(target.id,snapshot,nextVersion);
  res.json(await getTest(target.id, req.teacher!.id));
});

app.post('/api/join/:code', joinLimiter, async (req,res) => {
  const code = String(req.params.code).trim().toUpperCase();
  if (!/^QF-[A-Z0-9]{6}$/.test(code)) return res.status(400).json({ message:'Некорректный код теста.' });
  const name = String(req.body?.studentName ?? '').replace(/\s+/g,' ').trim().slice(0,120);
  const rows = await sql`SELECT * FROM tests WHERE share_code=${code} AND published=TRUE LIMIT 1`;
  const test = rows[0] as any;
  if (!test) return res.status(404).json({ message:'Тест с таким кодом не найден или закрыт.' });
  const settings = { ...defaultSettings, ...(test.settings_json ?? {}) } as any;
  if (settings.requireStudentName && !name) return res.status(400).json({ message:'Для этого теста необходимо указать имя или ник.' });
  const versionRows = await sql`SELECT id,snapshot_json FROM test_versions WHERE test_id=${test.id} AND version_number=${test.published_version ?? test.current_version} LIMIT 1`;
  const version = versionRows[0] as any;
  if (!version) return res.status(500).json({ message:'Не удалось определить версию теста.' });
  const accessToken = createOpaqueToken();
  const attemptId = newId();
  const snapshot = version.snapshot_json as TestSnapshot;
  const maxScore = snapshot.questions.reduce((sum,q)=>sum+q.points,0);
  await sql`INSERT INTO attempts (id,test_id,test_version_id,access_token_hash,student_name,max_score) VALUES (${attemptId},${test.id},${version.id},${hashToken(accessToken)},${name || 'Без имени'},${maxScore})`;
  const questions = structuredClone(snapshot.questions);
  if (settings.randomizeQuestions) questions.sort((a,b)=>stableSortKey(`${attemptId}:${a.id ?? a.position}`)-stableSortKey(`${attemptId}:${b.id ?? b.position}`));
  if (settings.randomizeOptions) {
    for (const q of questions) {
      if (q.type==='single_choice'||q.type==='multiple_choice') q.data.options = [...(q.data.options as any[])].sort((a,b)=>stableSortKey(`${attemptId}:${q.position}:${a.id}`)-stableSortKey(`${attemptId}:${q.position}:${b.id}`));
      if (q.type==='matching') q.data.pairs = [...(q.data.pairs as any[])].sort((a,b)=>stableSortKey(`${attemptId}:${q.position}:${a.id}`)-stableSortKey(`${attemptId}:${q.position}:${b.id}`));
    }
  }
  res.status(201).json({ attemptId, accessToken, startedAt:new Date().toISOString(), test:{id:test.id,title:test.title,description:test.description,durationSeconds:test.duration_seconds,settings,questions:questions.map(q=>({id:q.id ?? null,position:q.position,type:q.type,prompt:q.prompt,points:q.points,data:publicQuestion({id:q.id ?? null,position:q.position,type:q.type,prompt:q.prompt,points:q.points,data_json:q.data}).data}))} });
});

function stableSortKey(value: string): number {
  let hash = 2166136261;
  for (let i=0;i<value.length;i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return hash >>> 0;
}

function attemptToken(req: express.Request) { return String(req.header('x-attempt-token') || req.query.token || req.body?.accessToken || ''); }

app.get('/api/attempts/:id', async (req,res) => {
  const token = attemptToken(req);
  if (!token) return res.status(401).json({ message:'Нет ключа попытки.' });
  const a = await getAttemptByToken(req.params.id, token);
  if (!a) return res.status(404).json({ message:'Попытка не найдена.' });
  const versionRows = await sql`SELECT snapshot_json FROM test_versions WHERE id=${a.test_version_id} LIMIT 1`;
  const snapshot = versionRows[0]?.snapshot_json as TestSnapshot | undefined;
  const answerRows = await sql`SELECT question_id,answer_json,points,review_status,feedback,updated_at FROM attempt_answers WHERE attempt_id=${a.id}`;
  res.json({ attempt:{id:a.id,testId:a.test_id,studentName:a.student_name,status:a.status,reviewStatus:a.review_status,score:a.score,maxScore:a.max_score,startedAt:a.started_at,submittedAt:a.submitted_at,lastSeenAt:a.last_seen_at,warningCount:a.warning_count}, test:snapshot ? {title:snapshot.title,description:snapshot.description,durationSeconds:snapshot.durationSeconds,settings:snapshot.settings,questions:snapshot.questions.map(q=>publicQuestion({id:q.id ?? null,position:q.position,type:q.type,prompt:q.prompt,points:q.points,data_json:q.data}))} : null, answers:answerRows.map((r:any)=>({questionId:r.question_id,answer:r.answer_json,points:r.points,reviewStatus:r.review_status,feedback:r.feedback,updatedAt:r.updated_at})) });
});

app.post('/api/attempts/:id/heartbeat', attemptLimiter, async (req,res) => {
  const token = attemptToken(req); const a = await getAttemptByToken(req.params.id, token);
  if (!a) return res.status(404).json({ message:'Попытка не найдена.' });
  if (a.status === 'active') {
    const v = await sql`SELECT snapshot_json FROM test_versions WHERE id=${a.test_version_id} LIMIT 1`;
    const snapshot = v[0]?.snapshot_json as TestSnapshot | undefined;
    const started = new Date(a.started_at).getTime();
    if (snapshot?.durationSeconds && Date.now() > started + snapshot.durationSeconds * 1000 && !snapshot.settings.allowLateSubmit) {
      const result = await finalizeAttempt(a, snapshot, 'expired');
      return res.json({ ok:true, serverTime:new Date().toISOString(), status:'expired', ...result });
    }
  }
  await sql`UPDATE attempts SET last_seen_at=NOW() WHERE id=${a.id}`;
  res.json({ ok:true, serverTime:new Date().toISOString(), status:a.status });
});

app.post('/api/attempts/:id/answers', attemptLimiter, async (req,res) => {
  const token = attemptToken(req); const a = await getAttemptByToken(req.params.id, token);
  if (!a) return res.status(404).json({ message:'Попытка не найдена.' });
  if (a.status !== 'active') return res.status(409).json({ message:'Попытка уже завершена.' });
  const questionId = String(req.body?.questionId || '');
  const questionRows = await sql`SELECT snapshot_json FROM test_versions WHERE id=${a.test_version_id} LIMIT 1`;
  const snapshot = questionRows[0]?.snapshot_json as TestSnapshot | undefined;
  const question = snapshot?.questions.find(q => String(q.id) === questionId || String(q.position) === questionId);
  if (!question) return res.status(400).json({ message:'Вопрос не найден в этой версии теста.' });
  const answer = json(req.body?.answer);
  const clientUpdatedAtRaw = Number(req.body?.clientUpdatedAt);
  const clientUpdatedAt = Number.isFinite(clientUpdatedAtRaw) ? Math.max(0, Math.min(clientUpdatedAtRaw, Date.now() + 86400000)) : Date.now();
  const grade = gradeQuestion(question, answer);
  await sql`
    INSERT INTO attempt_answers (attempt_id,question_id,answer_json,is_correct,points,review_status,updated_at,client_updated_at)
    VALUES (${a.id},${questionId},${JSON.stringify(answer)}::jsonb,${grade.correct},${grade.points},${grade.reviewStatus},NOW(),${clientUpdatedAt})
    ON CONFLICT (attempt_id,question_id) DO UPDATE SET answer_json=EXCLUDED.answer_json,is_correct=EXCLUDED.is_correct,points=EXCLUDED.points,review_status=EXCLUDED.review_status,updated_at=NOW(),client_updated_at=EXCLUDED.client_updated_at
    WHERE attempt_answers.client_updated_at IS NULL OR EXCLUDED.client_updated_at >= attempt_answers.client_updated_at`;
  await sql`UPDATE attempts SET last_seen_at=NOW() WHERE id=${a.id}`;
  res.json({ ok:true,reviewStatus:grade.reviewStatus });
});

app.post('/api/attempts/:id/events', attemptLimiter, async (req,res) => {
  const token = attemptToken(req); const a = await getAttemptByToken(req.params.id, token);
  if (!a) return res.status(404).json({ message:'Попытка не найдена.' });
  const parsed = z.object({
    type: z.enum(['offline','online','pagehide','tab_hidden','tab_visible','heartbeat_timeout','auto_submit_pending']),
    payload: z.record(z.any()).optional().default({})
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message:'Недопустимое техническое событие.' });
  const type = parsed.data.type;
  const payload = parsed.data.payload;
  const warningTypes = new Set(['offline','pagehide','tab_hidden','heartbeat_timeout','auto_submit_pending']);
  const warning = warningTypes.has(type) ? 1 : 0;
  await sql`INSERT INTO attempt_events (id,attempt_id,event_type,payload_json) VALUES (${newId()},${a.id},${type},${JSON.stringify(payload)}::jsonb)`;
  await sql`UPDATE attempts SET last_seen_at=NOW(), last_event_type=${type}, warning_count=warning_count+${warning} WHERE id=${a.id}`;
  res.status(201).json({ ok:true });
});

app.post('/api/attempts/:id/submit', attemptLimiter, async (req,res) => {
  const token = attemptToken(req); const a = await getAttemptByToken(req.params.id, token);
  if (!a) return res.status(404).json({ message:'Попытка не найдена.' });
  if (a.status !== 'active') return res.json({ submitted:true, status:a.status, score:a.score, maxScore:a.max_score });
  const versionRows = await sql`SELECT snapshot_json FROM test_versions WHERE id=${a.test_version_id} LIMIT 1`;
  const snapshot = versionRows[0]?.snapshot_json as TestSnapshot | undefined;
  if (!snapshot) return res.status(500).json({ message:'Версия теста не найдена.' });
  const started = new Date(a.started_at).getTime();
  const expired = snapshot.durationSeconds > 0 && Date.now() > started + snapshot.durationSeconds*1000;
  if (expired && !snapshot.settings.allowLateSubmit) {
    await sql`UPDATE attempts SET status='expired',submitted_at=NOW(),last_seen_at=NOW() WHERE id=${a.id}`;
    return res.status(409).json({ message:'Время теста истекло.', status:'expired' });
  }
  const result = await finalizeAttempt(a, snapshot, expired ? 'expired' : 'submitted');
  res.json({ submitted:true,status:expired?'expired':'submitted',...result,showScore:snapshot.settings.showScoreOnSubmit });
});

app.get('/api/cron/cleanup', async (req,res) => {
  const expected = process.env.CRON_SECRET || '';
  const supplied = String(req.get('authorization') || '').replace(/^Bearer\s+/i,'');
  if (!expected || expected.length < 20 || supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) {
    return res.status(401).json({ message:'Недействительная подпись cron-запроса.' });
  }
  const rows = await sql`
    SELECT a.*, tv.snapshot_json
    FROM attempts a
    JOIN test_versions tv ON tv.id=a.test_version_id
    WHERE a.status='active'
      AND (tv.snapshot_json->>'durationSeconds')::int > 0
      AND a.started_at + (((tv.snapshot_json->>'durationSeconds')::int) * INTERVAL '1 second') < NOW()
      AND COALESCE((tv.snapshot_json->'settings'->>'allowLateSubmit')::boolean,FALSE)=FALSE
    ORDER BY a.started_at ASC LIMIT 200`;
  let finalized = 0;
  for (const row of rows as any[]) { await finalizeAttempt(row, row.snapshot_json as TestSnapshot, 'expired'); finalized += 1; }
  await sql`DELETE FROM sessions WHERE expires_at < NOW()`;
  res.json({ ok:true, finalized, sessionsCleaned:true, time:new Date().toISOString() });
});

app.get('/api/tests/:id/versions', requireTeacher, async (req:AuthRequest,res) => {
  const owned = await sql`SELECT id FROM tests WHERE id=${req.params.id} AND teacher_id=${req.teacher!.id} LIMIT 1`;
  if (!owned[0]) return res.status(404).json({ message:'Тест не найден.' });
  const rows = await sql`SELECT id,version_number,created_at FROM test_versions WHERE test_id=${req.params.id} ORDER BY version_number DESC`;
  res.json(rows.map((r:any)=>({id:r.id,versionNumber:Number(r.version_number),createdAt:r.created_at})));
});

app.get('/api/tests/:id/results', requireTeacher, async (req:AuthRequest,res) => {
  const owned = await sql`SELECT id FROM tests WHERE id=${req.params.id} AND teacher_id=${req.teacher!.id} LIMIT 1`;
  if (!owned[0]) return res.status(404).json({ message:'Тест не найден.' });
  const rows = await sql`SELECT id,student_name,status,review_status,score,max_score,started_at,submitted_at,last_seen_at,warning_count,last_event_type FROM attempts WHERE test_id=${req.params.id} ORDER BY started_at DESC`;
  res.json(rows.map((r:any)=>({id:r.id,studentName:r.student_name,status:r.status,reviewStatus:r.review_status,score:r.score==null?null:Number(r.score),maxScore:r.max_score==null?null:Number(r.max_score),startedAt:r.started_at,submittedAt:r.submitted_at,lastSeenAt:r.last_seen_at,warningCount:Number(r.warning_count),lastEventType:r.last_event_type})));
});

app.get('/api/attempts/:id/events', requireTeacher, async (req:AuthRequest,res) => {
  const rows = await sql`
    SELECT e.id,e.event_type,e.payload_json,e.created_at
    FROM attempt_events e JOIN attempts a ON a.id=e.attempt_id
    JOIN tests t ON t.id=a.test_id
    WHERE e.attempt_id=${req.params.id} AND t.teacher_id=${req.teacher!.id}
    ORDER BY e.created_at DESC LIMIT 500`;
  res.json(rows.map((r:any)=>({id:r.id,type:r.event_type,payload:r.payload_json,createdAt:r.created_at})));
});

app.get('/api/attempts/:id/detail', requireTeacher, async (req:AuthRequest,res) => {
  const rows = await sql`SELECT a.*,t.title FROM attempts a JOIN tests t ON t.id=a.test_id WHERE a.id=${req.params.id} AND t.teacher_id=${req.teacher!.id} LIMIT 1`;
  const a = rows[0] as any;
  if (!a) return res.status(404).json({ message:'Попытка не найдена.' });
  const versionRows = await sql`SELECT snapshot_json FROM test_versions WHERE id=${a.test_version_id} LIMIT 1`;
  const snapshot = versionRows[0]?.snapshot_json as TestSnapshot;
  const answerRows = await sql`SELECT * FROM attempt_answers WHERE attempt_id=${a.id} ORDER BY updated_at ASC`;
  res.json({ attempt:{id:a.id,studentName:a.student_name,status:a.status,reviewStatus:a.review_status,score:a.score==null?null:Number(a.score),maxScore:a.max_score==null?null:Number(a.max_score),startedAt:a.started_at,submittedAt:a.submitted_at,lastSeenAt:a.last_seen_at,warningCount:Number(a.warning_count)}, questions:snapshot.questions, answers:answerRows.map((r:any)=>({questionId:r.question_id,answer:r.answer_json,points:r.points==null?null:Number(r.points),reviewStatus:r.review_status,feedback:r.feedback})) });
});

app.post('/api/attempts/:id/manual-grade', requireTeacher, async (req:AuthRequest,res) => {
  const body = z.object({ questionId:z.string(), points:z.number().min(0).max(1000), feedback:z.string().max(4000).optional().default('') }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ message:'Некорректная оценка.' });
  const rows = await sql`SELECT a.*,t.teacher_id FROM attempts a JOIN tests t ON t.id=a.test_id WHERE a.id=${req.params.id} AND t.teacher_id=${req.teacher!.id} LIMIT 1`;
  const a = rows[0] as any;
  if (!a) return res.status(404).json({ message:'Попытка не найдена.' });
  const versionRows = await sql`SELECT snapshot_json FROM test_versions WHERE id=${a.test_version_id} LIMIT 1`;
  const snapshot = versionRows[0]?.snapshot_json as TestSnapshot | undefined;
  const question = snapshot?.questions.find(q => String(q.id) === body.data.questionId);
  if (!question) return res.status(404).json({ message:'Вопрос не найден в версии попытки.' });
  if (body.data.points > question.points) return res.status(400).json({ message:`Максимум для этого вопроса: ${question.points} балл(ов).` });
  const answerRows = await sql`SELECT question_id FROM attempt_answers WHERE attempt_id=${a.id} AND question_id=${body.data.questionId} LIMIT 1`;
  if (!answerRows[0]) return res.status(404).json({ message:'Ответ на вопрос не найден.' });
  await sql`UPDATE attempt_answers SET points=${body.data.points},review_status='reviewed',feedback=${body.data.feedback},is_correct=${body.data.points>0},updated_at=NOW() WHERE attempt_id=${a.id} AND question_id=${body.data.questionId}`;
  const sumRows = await sql`SELECT COALESCE(SUM(points),0)::numeric AS earned, BOOL_OR(review_status='pending') AS pending FROM attempt_answers WHERE attempt_id=${a.id}`;
  const s = sumRows[0] as any;
  await sql`UPDATE attempts SET score=${Number(s.earned)},review_status=${s.pending?'unreviewed':'reviewed'} WHERE id=${a.id}`;
  res.json({ ok:true,score:Number(s.earned),reviewStatus:s.pending?'unreviewed':'reviewed' });
});

app.post('/api/attempts/:id/review', requireTeacher, async (req:AuthRequest,res) => {
  const rows = await sql`SELECT a.id FROM attempts a JOIN tests t ON t.id=a.test_id WHERE a.id=${req.params.id} AND t.teacher_id=${req.teacher!.id} LIMIT 1`;
  if (!rows[0]) return res.status(404).json({ message:'Попытка не найдена.' });
  await sql`UPDATE attempts SET review_status='reviewed' WHERE id=${req.params.id}`;
  res.json({ ok:true });
});

if (process.env.SERVE_CLIENT === 'true') {
  const clientDist = path.resolve(process.cwd(), 'client/dist');
  app.use(express.static(clientDist, { index: false }));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/')) return res.sendFile(path.join(clientDist, 'index.html'));
    next();
  });
}

app.use((error:any, _req:express.Request, res:express.Response, _next:express.NextFunction) => {
  console.error(error);
  res.status(500).json({ message:'Внутренняя ошибка сервера.' });
});

export default app;
