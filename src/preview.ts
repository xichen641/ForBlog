import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { inside } from './files';
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg' };
export class PreviewServer {
  private server?: Server;
  async start(root: string, siteUrl: string, port: number): Promise<void> {
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('预览端口必须在 1024–65535 之间');
    await this.stop();
    const prefix = decodeURIComponent(new URL(siteUrl).pathname).replace(/\/$/, '');
    this.server = createServer(async (request, response) => {
      try {
        if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(405).end(); return; }
        const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
        if (prefix && pathname !== prefix && !pathname.startsWith(prefix + '/')) { response.writeHead(404).end(); return; }
        let relative = pathname.slice(prefix.length).replace(/^\//, '');
        if (!relative || relative.endsWith('/')) relative += 'index.html';
        const file = await inside(root, relative);
        const data = await fs.readFile(file);
        response.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': data.length });
        response.end(request.method === 'HEAD' ? undefined : data);
      } catch { response.writeHead(404).end('Not found'); }
    });
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(port, '127.0.0.1', () => { this.server!.removeListener('error', reject); resolve(); }); });
  }
  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server; this.server = undefined;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  url(siteUrl: string, slug: string, port: number): string {
    return `http://127.0.0.1:${port}${new URL(siteUrl).pathname.replace(/\/$/, '')}/posts/${slug}/`;
  }
}
