import assert from 'node:assert/strict';
import test from 'node:test';
import { adjacentPacketTime, createRail, flightSpans, historyRange } from './timelineHistory.ts';

const rows = times => times.map(t => ({ t }));

test('fleet range spans mixed histories, including empty and single-packet flights', () => {
    assert.equal(historyRange([]), null);
    assert.equal(historyRange([[], []]), null);
    assert.deepEqual(historyRange([rows([20, 40]), [], rows([0]), rows([15, 90])]), { start: 0, end: 90 });
    assert.deepEqual(historyRange([rows([0])]), { start: 0, end: 0 });
});

test('keyboard replay skips equal timestamps and crosses gaps between balloons', () => {
    const histories = [rows([10, 20, 20, 50]), rows([5, 20, 30, 60]), []];
    for (const [time, previous, next] of [[0, null, 5], [5, null, 10], [20, 10, 30], [25, 20, 30], [60, 50, null], [100, 60, null]]) {
        assert.equal(adjacentPacketTime(histories, time, 'previous'), previous);
        assert.equal(adjacentPacketTime(histories, time, 'next'), next);
    }
    assert.equal(adjacentPacketTime([[]], 0, 'next'), null);
});

test('fleet navigation matches a merged timeline without changing packet arrays', () => {
    const histories = Array.from({ length: 70 }, (_, i) => Object.freeze(rows(Array.from({ length: i % 13 }, (_, j) => (i * 19 + j * 37) % 1000).sort((a, b) => a - b))));
    const merged = histories.flat().sort((a, b) => a.t - b.t);
    assert.deepEqual(historyRange(histories), { start: merged[0].t, end: merged.at(-1).t });
    for (let time = -10; time <= 1010; time += 7) {
        assert.equal(adjacentPacketTime(histories, time, 'previous'), merged.findLast(row => row.t < time)?.t ?? null);
        assert.equal(adjacentPacketTime(histories, time, 'next'), merged.find(row => row.t > time)?.t ?? null);
    }
});

test('range and keyboard lookup inspect endpoints and logarithmic candidates, not all fleet packets', () => {
    let reads = 0;
    const histories = Array.from({ length: 100 }, (_, i) => Array.from({ length: 10000 }, (_, j) => ({ get t() { reads++; return j * 100 + i; } })));
    assert.deepEqual(historyRange(histories), { start: 0, end: 999999 });
    assert.equal(reads, 200);
    reads = 0;
    assert.equal(adjacentPacketTime(histories, 500000, 'previous'), 499999);
    assert.ok(reads < 1600, `inspected ${reads} timestamps`);
    reads = 0;
    assert.equal(adjacentPacketTime(histories, 500000, 'next'), 500001);
    assert.ok(reads < 1600, `inspected ${reads} timestamps`);
});

test('flight spans start at launch, run to the last packet or live estimate, and merge close flights', () => {
    const h = 3_600_000;
    assert.deepEqual(flightSpans([
        { launchT: 100 * h, rows: rows([50 * h, 100 * h, 200 * h]) },
        { launchT: null, rows: rows([0, 1000 * h]) },
        { launchT: 900 * h, rows: rows([900 * h, 950 * h]), liveUntil: 1200 * h },
        { launchT: 5, rows: [] },
    ]), [{ start: 100 * h, end: 200 * h }, { start: 900 * h, end: 1200 * h }]);
    assert.deepEqual(flightSpans([{ launchT: 0, rows: rows([h]) }, { launchT: 13 * h + 1, rows: rows([14 * h]) }]).length, 2);
    assert.deepEqual(flightSpans([{ launchT: 0, rows: rows([h]) }, { launchT: 12 * h, rows: rows([14 * h]) }]), [{ start: 0, end: 14 * h }]);
});

test('a rail over one span is the plain linear scrubber', () => {
    const rail = createRail([{ start: 100, end: 200 }]);
    assert.equal(rail.toFrac(150), 0.5);
    assert.equal(rail.toFrac(50), 0);
    assert.equal(rail.toFrac(300), 1);
    assert.equal(rail.toTime(0.25), 125);
    assert.equal(rail.snap(150, 'next'), 150);
});

test('a rail leaves out the time between spans and round-trips within them', () => {
    const rail = createRail([{ start: 0, end: 1000 }, { start: 100_000, end: 101_000 }]);
    const [a, b] = rail.spans;
    assert.equal(a.from, 0);
    assert.equal(b.to, 1);
    assert.ok(b.from - a.to > 0 && b.from - a.to < 0.05, 'a short break, not 99 seconds of nothing');
    assert.ok(Math.abs((a.to - a.from) - (b.to - b.from)) < 1e-9, 'equal flights get equal rail');
    for (const t of [0, 250, 1000, 100_000, 100_500, 101_000]) assert.ok(Math.abs(rail.toTime(rail.toFrac(t)) - t) < 1e-6, String(t));
    assert.equal(rail.toFrac(50_000), b.from, 'time between flights sits at the next one');
    assert.equal(rail.toTime(a.to + 0.001), 1000);
    assert.equal(rail.toTime(b.from - 0.001), 100_000);
    assert.equal(rail.snap(50_000, 'next'), 100_000);
    assert.equal(rail.snap(50_000, 'previous'), 1000);
});

test('a short flight beside a long one keeps a usable share of the rail', () => {
    const rail = createRail([{ start: 0, end: 1_000_000 }, { start: 2_000_000, end: 2_001_000 }]);
    assert.ok(Math.abs((rail.spans[1].to - rail.spans[1].from) - 0.15 * 0.985) < 1e-9);
});
