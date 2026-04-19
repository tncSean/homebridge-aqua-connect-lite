/**
 * Drive the AquaLogic capture through FrameExtractor → PoolStateStore
 * and assert the expected fields populate. Confirms the display-text
 * regexes match the live display output.
 *
 * Run with: npx ts-node scripts/verify-state.ts
 */
import * as fs from 'fs';
import { FrameExtractor } from '../src/aqualogic/frame';
import { PoolStateStore } from '../src/aqualogic/state';

const CAPTURE = '/tmp/aqualogic-capture.bin';
if (!fs.existsSync(CAPTURE)) {
    console.warn(`! capture file ${CAPTURE} not found`);
    process.exit(0);
}

const bytes = fs.readFileSync(CAPTURE);
const extractor = new FrameExtractor();
const store = new PoolStateStore();

const changes: string[] = [];
store.on('change', (key, value) => changes.push(`${String(key)}=${JSON.stringify(value)}`));

extractor.on('frame', p => store.ingest(p));

// Simulate realistic socket-chunk boundaries.
for (let i = 0; i < bytes.length; i += 64) {
    extractor.push(bytes.subarray(i, Math.min(i + 64, bytes.length)));
}

const s = store.current;
console.log('final state:');
console.log(JSON.stringify(s, null, 2));
console.log('\nchange events:', changes.length);
for (const c of changes) console.log(`  ${c}`);

// Expectations from the 60s capture we already know ran through:
// display cycled through Pool Chlorinator 30%, Heater Auto, Filter Speed 90%,
// and Pool Temp 47-48°F.
const expect = (name: string, cond: boolean, got: unknown) => {
    const mark = cond ? 'PASS' : 'FAIL';
    console.log(`${mark}  ${name}  (got=${JSON.stringify(got)})`);
    return cond;
};

let ok = true;
ok = expect('poolTempF in 40..55', typeof s.poolTempF === 'number' && s.poolTempF! >= 40 && s.poolTempF! <= 55, s.poolTempF) && ok;
ok = expect('chlorinatorPercent == 30', s.chlorinatorPercent === 30, s.chlorinatorPercent) && ok;
// "Heater1 Auto Control" cycles in the 60s capture → heater armed, numeric
// setpoint programmed. heaterSetpointF stays undefined until a SET TO line
// scrolls by (not present in this capture).
ok = expect('heaterMode == auto', s.heaterMode === 'auto', s.heaterMode) && ok;
ok = expect('pumpPercent == 90', s.pumpPercent === 90, s.pumpPercent) && ok;
ok = expect('filterOn == true', s.filterOn === true, s.filterOn) && ok;

process.exit(ok ? 0 : 1);
