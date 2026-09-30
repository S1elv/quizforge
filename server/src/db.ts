import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL не задан. Создайте Neon PostgreSQL и добавьте DATABASE_URL в окружение.');
}

export const sql = neon(databaseUrl);

let schemaPromise: Promise<void> | null = null;

const statements = [
  `CREATE TABLE IF NOT EXISTS teachers (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS sessions_token_hash_idx ON sessions(token_hash)`,
  `CREATE TABLE IF NOT EXISTS tests (
    id TEXT PRIMARY KEY,
    teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    duration_seconds INTEGER NOT NULL DEFAULT 600 CHECK (duration_seconds >= 0),
    settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    published BOOLEAN NOT NULL DEFAULT FALSE,
    share_code TEXT UNIQUE,
    current_version INTEGER NOT NULL DEFAULT 1,
    published_version INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS tests_teacher_updated_idx ON tests(teacher_id, updated_at DESC)`,
  `ALTER TABLE tests ADD COLUMN IF NOT EXISTS published_version INTEGER`,
  `UPDATE tests SET published_version = current_version WHERE published = TRUE AND published_version IS NULL`,
  `CREATE INDEX IF NOT EXISTS tests_share_code_idx ON tests(share_code) WHERE share_code IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS test_versions (
    id TEXT PRIMARY KEY,
    test_id TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    snapshot_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(test_id, version_number)
  )`,
  `CREATE INDEX IF NOT EXISTS test_versions_test_idx ON test_versions(test_id, version_number DESC)`,
  `CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    test_id TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    type TEXT NOT NULL,
    prompt TEXT NOT NULL,
    points NUMERIC(10,2) NOT NULL DEFAULT 1,
    data_json JSONB NOT NULL DEFAULT '{}'::jsonb
  )`,
  `CREATE INDEX IF NOT EXISTS questions_test_pos_idx ON questions(test_id, position)`,
  `CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY,
    test_id TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
    test_version_id TEXT NOT NULL REFERENCES test_versions(id) ON DELETE RESTRICT,
    access_token_hash TEXT NOT NULL UNIQUE,
    student_name TEXT NOT NULL DEFAULT 'Без имени',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','submitted','expired')),
    review_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed','reviewed')),
    score NUMERIC(10,2),
    max_score NUMERIC(10,2),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    submitted_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    warning_count INTEGER NOT NULL DEFAULT 0,
    last_event_type TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS attempts_test_idx ON attempts(test_id, started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS attempts_token_idx ON attempts(access_token_hash)`,
  `CREATE TABLE IF NOT EXISTS attempt_answers (
    attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL,
    answer_json JSONB NOT NULL DEFAULT 'null'::jsonb,
    is_correct BOOLEAN,
    points NUMERIC(10,2),
    review_status TEXT NOT NULL DEFAULT 'not_needed' CHECK (review_status IN ('not_needed','pending','reviewed')),
    feedback TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    client_updated_at BIGINT,
    PRIMARY KEY (attempt_id, question_id)
  )`,
  `ALTER TABLE attempt_answers ADD COLUMN IF NOT EXISTS client_updated_at BIGINT`,
  `CREATE INDEX IF NOT EXISTS attempt_answers_attempt_idx ON attempt_answers(attempt_id)`,
  `CREATE TABLE IF NOT EXISTS attempt_events (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS attempt_events_attempt_idx ON attempt_events(attempt_id, created_at DESC)`,
];

export async function ensureSchema(): Promise<void> {
  schemaPromise ??= (async () => {
    for (const statement of statements) await sql.query(statement);
  })();
  await schemaPromise;
}
