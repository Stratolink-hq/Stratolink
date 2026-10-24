import test from 'node:test';
import assert from 'node:assert/strict';
import {projectedPosition} from './projectedPosition.js';
const start=Date.parse('2026-10-23T00:00:00Z');
const forecast={forecast_origin:{time_utc:new Date(start).toISOString()},forecast_horizon_h:2,nominal_path:[[179,10],[-179,20]]};
test('projection crosses the dateline instead of crossing the world',()=>{
 assert.deepEqual(projectedPosition(forecast,start+3600000),{lon:-180,lat:15,t:start+3600000});
});
test('projection stops at the modeled horizon and rejects invalid geometry',()=>{
 assert.deepEqual(projectedPosition(forecast,start+20*3600000),{lon:-179,lat:20,t:start+2*3600000});
 assert.equal(projectedPosition(forecast,start-1),null);
 assert.equal(projectedPosition({...forecast,nominal_path:[[0,100]]},start),null);
 assert.equal(projectedPosition(null,start),null);
});
