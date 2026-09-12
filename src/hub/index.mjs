// `npm run hub` entry point: node src/hub/index.mjs --config config.json [--port 4747]
import { startHub } from './server.mjs';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

startHub({ configPath: arg('--config', 'config.json'), port: arg('--port') ? Number(arg('--port')) : undefined })
  .then(({ url }) => {
    console.log(`[${new Date().toISOString()}] Daily Job Match Alert hub listening on ${url} (local only)`);
  })
  .catch(error => {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  });
