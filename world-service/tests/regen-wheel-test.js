import { strict as assert } from 'node:assert';
import { ResourceRegenWheel } from '../src/engine/ResourceRegenWheel.js';

console.log('🧪 Starting ResourceRegenWheel Unit Tests...\n');

// TEST 1: Basic scheduling and expiration at exact second
console.log('⏱️  [Test 1] Basic Scheduling and Expiration');
const wheel = new ResourceRegenWheel(64);
const startMs = 1000000; // e.g. 1000s
wheel.tick(startMs); // Initialize baseline

wheel.schedule('tree_1', 'branches', 30, startMs);
wheel.schedule('tree_1', 'full', 60, startMs);

// Tick at +15 seconds: nothing should expire
let due = wheel.tick(startMs + 15000);
assert.equal(due.length, 0, 'No events due at 15s');

// Tick at +29 seconds: nothing should expire
due = wheel.tick(startMs + 29000);
assert.equal(due.length, 0, 'No events due at 29s');

// Tick at +30 seconds: 'branches' should expire
due = wheel.tick(startMs + 30000);
assert.equal(due.length, 1, 'Exactly 1 event due at 30s');
assert.equal(due[0].resourceId, 'tree_1');
assert.equal(due[0].targetStage, 'branches');
console.log('  ✅ PASS: 30s event triggered exactly on time');

// Tick at +45 seconds: nothing should expire
due = wheel.tick(startMs + 45000);
assert.equal(due.length, 0, 'No events due at 45s');

// Tick at +60 seconds: 'full' should expire
due = wheel.tick(startMs + 60000);
assert.equal(due.length, 1, 'Exactly 1 event due at 60s');
assert.equal(due[0].resourceId, 'tree_1');
assert.equal(due[0].targetStage, 'full');
console.log('  ✅ PASS: 60s event triggered exactly on time');

// TEST 2: Stall Catch-up (Multiple seconds in one tick)
console.log('\n🦘 [Test 2] Multi-second Stall Catch-up');
const wheel2 = new ResourceRegenWheel(64);
const t0 = 2000000;
wheel2.tick(t0);

wheel2.schedule('tree_2', 'branches', 10, t0);
wheel2.schedule('bush_1', 'full', 12, t0);

// Tick leaps 15 seconds into the future in one call
const leapDue = wheel2.tick(t0 + 15000);
assert.equal(leapDue.length, 2, 'Both elapsed events collected during leap');
assert(leapDue.some((e) => e.resourceId === 'tree_2' && e.targetStage === 'branches'), 'tree_2 included in catch-up');
assert(leapDue.some((e) => e.resourceId === 'bush_1' && e.targetStage === 'full'), 'bush_1 included in catch-up');
console.log('  ✅ PASS: Stalled or leaping ticks do not lose any scheduled events');

// TEST 3: Multiple resources scheduled at same time
console.log('\n👥 [Test 3] Multiple Resources Same Bucket');
const wheel3 = new ResourceRegenWheel(64);
const t1 = 3000000;
wheel3.tick(t1);

wheel3.schedule('bush_1', 'full', 30, t1);
wheel3.schedule('bush_2', 'full', 30, t1);
wheel3.schedule('tree_3', 'branches', 30, t1);

const sameBucketDue = wheel3.tick(t1 + 30000);
assert.equal(sameBucketDue.length, 3, 'All 3 items in same bucket returned');
console.log('  ✅ PASS: Multiple resources in the same bucket are all returned');

// TEST 4: Sub-second high frequency ticks do not duplicate or miss
console.log('\n🏎️  [Test 4] 20 Hz Sub-second Ticks');
const wheel4 = new ResourceRegenWheel(64);
let simTime = 4000000;
wheel4.tick(simTime);
wheel4.schedule('tree_10', 'branches', 2, simTime);

let totalCollected = 0;
for (let step = 0; step < 60; step++) { // 3 seconds at 20 Hz (50ms)
  simTime += 50;
  const events = wheel4.tick(simTime);
  totalCollected += events.length;
}
assert.equal(totalCollected, 1, 'Event fired exactly once across 60 20Hz ticks');
console.log('  ✅ PASS: Sub-second ticks fire event exactly once without duplicates');

console.log('\n📊 All ResourceRegenWheel Tests Passed Successfully!');
