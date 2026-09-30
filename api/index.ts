import app from '../server/src/app.js';

export default function handler(req: any, res: any) {
  if (typeof req.url === 'string') {
    const parsed = new URL(req.url, 'http://vercel.internal');
    const originalPath = parsed.searchParams.get('__qf_path');
    if (originalPath !== null) {
      parsed.searchParams.delete('__qf_path');
      const suffix = parsed.searchParams.toString();
      const normalized = originalPath.replace(/^\/+/, '');
      req.url = `/api/${normalized}${suffix ? `?${suffix}` : ''}`;
    } else if (parsed.pathname === '/api/index') {
      req.url = `/api${parsed.search ? parsed.search : ''}`;
    }
  }
  return app(req, res);
}
