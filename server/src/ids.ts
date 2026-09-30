import { createHash, randomBytes, randomUUID } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}

export function createOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function makeShareCode(existing: (code: string) => Promise<boolean>): Promise<string> {
  const create = async (): Promise<string> => {
    const code = `QF-${randomBytes(3).toString('hex').toUpperCase()}`;
    if (await existing(code)) return create();
    return code;
  };
  return create();
}
