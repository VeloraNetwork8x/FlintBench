// `npm run reset-setup`: the next start of FlintBench asks to create the account and runs the
// setup wizard again. The current account file is kept aside, never deleted.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestReset } from './settings/reset-setup.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = path.resolve(process.env.FLINTBENCH_DATA_DIR || path.join(root, 'data'));
await requestReset(dataDir);
console.log(`Reset asked for ${dataDir}. Restart FlintBench (npm start): it will ask to create the account, then run the setup.`);
