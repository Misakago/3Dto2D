import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// 开发期接口：保存浏览器渲染的样例缩略图到 public/samples/thumbs/
const thumbSaver = {
  name: 'thumb-saver',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use('/__thumb', (req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const { id, data, local } = JSON.parse(body);
          if (!/^[a-z0-9]+$/.test(id)) throw new Error('bad id');
          const dir = path.resolve(local ? 'public/samples/local/thumbs' : 'public/samples/thumbs');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, id + '.webp'), Buffer.from(data.split(',')[1], 'base64'));
          res.end('ok');
        } catch (e) {
          res.statusCode = 400;
          res.end(String(e));
        }
      });
    });
  },
};

export default defineConfig({
  base: './',
  server: { port: 5199 },
  build: { chunkSizeWarningLimit: 2000 },
  plugins: [thumbSaver],
});
