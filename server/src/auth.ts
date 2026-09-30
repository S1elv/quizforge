import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { sql } from './db.js';
import { createOpaqueToken, hashToken, newId } from './ids.js';

const SESSION_COOKIE = 'qf_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

export type Teacher = { id: string; username: string; displayName: string };
export type AuthRequest = Request & { teacher?: Teacher };

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_TTL_MS,
  };
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, expectedHex] = stored.split(':');
  if (!saltHex || !expectedHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

export async function authenticateTeacher(username: string, password: string): Promise<Teacher | null> {
  const rows = await sql`SELECT id, username, display_name, password_hash FROM teachers WHERE username = ${username.trim().toLowerCase()} LIMIT 1`;
  const row = rows[0] as any;
  if (!row || !verifyPassword(password, row.password_hash)) return null;
  return { id: row.id, username: row.username, displayName: row.display_name };
}

export async function createSession(teacher: Teacher, res: Response): Promise<void> {
  const rawToken = createOpaqueToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await sql`INSERT INTO sessions (id, teacher_id, token_hash, expires_at) VALUES (${newId()}, ${teacher.id}, ${hashToken(rawToken)}, ${expiresAt.toISOString()})`;
  res.cookie(SESSION_COOKIE, rawToken, cookieOptions());
}

export async function destroySession(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) await sql`DELETE FROM sessions WHERE token_hash = ${hashToken(String(token))}`;
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' });
}

export async function requireTeacher(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return res.status(401).json({ message: 'Требуется вход преподавателя.' });
    const rows = await sql`
      SELECT t.id, t.username, t.display_name
      FROM sessions s
      JOIN teachers t ON t.id = s.teacher_id
      WHERE s.token_hash = ${hashToken(String(token))} AND s.expires_at > NOW()
      LIMIT 1`;
    const row = rows[0] as any;
    if (!row) return res.status(401).json({ message: 'Сессия истекла. Войдите снова.' });
    req.teacher = { id: row.id, username: row.username, displayName: row.display_name };
    next();
  } catch {
    return res.status(500).json({ message: 'Не удалось проверить сессию.' });
  }
}

export { SESSION_COOKIE };
