import { loadConfig } from './config.mjs';
import { syncResumes } from './resume-sync.mjs';

const configIndex = process.argv.indexOf('--config');
const configPath = configIndex >= 0 && process.argv[configIndex + 1] ? process.argv[configIndex + 1] : 'config.json';
const result = await syncResumes(await loadConfig(configPath));
console.log(JSON.stringify(result, null, 2));
