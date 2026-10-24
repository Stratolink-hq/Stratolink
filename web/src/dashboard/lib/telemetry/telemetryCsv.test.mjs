import test from 'node:test';
import assert from 'node:assert/strict';
import { telemetryCsv } from './telemetryCsv.ts';

test('exports sparse records, negative readings, quoted text and gateway metadata', () => {
    const csv = telemetryCsv([
        { time: '2026-10-23', temperature: -2.5, note: 'one,"two"\nthree', gateways: [{ id: 'a' }] },
        { time: '2026-10-24', pressure: 400 },
    ]);
    assert.ok(csv.startsWith('"time","temperature","note","gateways","pressure"\r\n'));
    assert.ok(csv.includes('"-2.5"'));
    assert.ok(csv.includes('"one,""two""\nthree"'));
    assert.ok(csv.includes('"[{""id"":""a""}]"'));
    assert.ok(csv.endsWith('"2026-10-24","","","","400"'));
});
test('neutralizes formula strings without changing numeric values', () => {
    assert.equal(telemetryCsv([{ value: '=HYPERLINK("x")', numeric: -1 }]),
        '"value","numeric"\r\n"\'=HYPERLINK(""x"")","-1"');
    for (const value of ['+SUM(1)', '-SUM(1)', '@SUM(1)', ' \t=SUM(1)']) {
        assert.ok(telemetryCsv([{ value }]).includes('"\'' + value + '"'));
    }
});
