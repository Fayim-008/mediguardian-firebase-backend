import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDose, computeInstants } from '../src/services/doseService.js';
import { isQualifying } from '../src/services/deviceService.js';

const S = '2026-03-01T08:00:00Z';
const at = (min) => new Date(new Date(S).getTime() + min * 60000).toISOString();
const c = (evMin, nowMin = 100000) => classifyDose({ scheduledAt: S, evidenceAt: evMin == null ? null : at(evMin), now: new Date(at(nowMin)) });

test('classifyDose: on_time within 60 min (boundaries inclusive)', () => {
  assert.equal(c(0), 'on_time'); assert.equal(c(60), 'on_time'); assert.equal(c(30), 'on_time');
});
test('classifyDose: late after 60 min, before 24h', () => {
  assert.equal(c(61), 'late'); assert.equal(c(24 * 60 - 1), 'late');
});
test('classifyDose: evidence at/after 24h does NOT complete the dose (missed)', () => {
  assert.equal(c(24 * 60), 'missed'); assert.equal(c(30 * 60), 'missed');
});
test('classifyDose: evidence BEFORE scheduled time is not valid evidence', () => {
  assert.equal(c(-5, -10), 'upcoming'); assert.equal(c(-5, 10), 'awaiting_confirmation');
});
test('classifyDose: no evidence -> upcoming / awaiting / missed by clock', () => {
  assert.equal(c(null, -1), 'upcoming'); assert.equal(c(null, 5), 'awaiting_confirmation'); assert.equal(c(null, 24 * 60), 'missed');
});
test('classifyDose: configurable policy changes outcomes', () => {
  const r = (g) => classifyDose({ scheduledAt: S, evidenceAt: at(45), graceMinutes: g, now: new Date(at(1000)) });
  assert.equal(r(30), 'late'); assert.equal(r(90), 'on_time');
});
test('isQualifying implements reed AND (IR_A OR IR_B)', () => {
  assert.equal(isQualifying({ reed_open: true, ir_a: true, ir_b: false }), true);
  assert.equal(isQualifying({ reed_open: true, ir_a: false, ir_b: true }), true);
  assert.equal(isQualifying({ reed_open: true, ir_a: false, ir_b: false }), false);
  assert.equal(isQualifying({ reed_open: false, ir_a: true, ir_b: true }), false);
  assert.equal(isQualifying(undefined), false);
});

const sched = (o) => ({ effective_from: '2020-01-01T00:00:00Z', ...o });
test('computeInstants: multiple daily times, patient time zone (Dhaka UTC+6)', () => {
  const r = computeInstants({ schedule: sched({ schedule_type: 'times', times_local: ['08:00', '21:00'] }), medicine: {}, timezone: 'Asia/Dhaka',
    from: new Date('2026-03-01T00:00:00Z'), to: new Date('2026-03-01T23:59:00Z') });
  assert.deepEqual(r.map((d) => d.toISOString()), ['2026-03-01T02:00:00.000Z', '2026-03-01T15:00:00.000Z']);
});
test('computeInstants: interval schedule every 8h crosses midnight and has no duplicates', () => {
  const r = computeInstants({ schedule: sched({ schedule_type: 'interval', interval_hours: 8, anchor_local: '22:00', anchor_date: '2026-03-01' }), medicine: {}, timezone: 'UTC',
    from: new Date('2026-03-01T00:00:00Z'), to: new Date('2026-03-03T00:00:00Z') });
  assert.deepEqual(r.map((d) => d.toISOString()), ['2026-03-01T22:00:00.000Z', '2026-03-02T06:00:00.000Z', '2026-03-02T14:00:00.000Z', '2026-03-02T22:00:00.000Z']);
});
test('computeInstants: effective_from prevents back-filling history', () => {
  const r = computeInstants({ schedule: sched({ schedule_type: 'times', times_local: ['08:00'], effective_from: '2026-03-02T00:00:00Z' }), medicine: {}, timezone: 'UTC',
    from: new Date('2026-03-01T00:00:00Z'), to: new Date('2026-03-03T00:00:00Z') });
  assert.deepEqual(r.map((d) => d.toISOString()), ['2026-03-02T08:00:00.000Z']);
});
test('computeInstants: start/end dates respected in patient local date', () => {
  const r = computeInstants({ schedule: sched({ schedule_type: 'times', times_local: ['08:00'] }), medicine: { start_date: '2026-03-02', end_date: '2026-03-02' }, timezone: 'UTC',
    from: new Date('2026-03-01T00:00:00Z'), to: new Date('2026-03-04T00:00:00Z') });
  assert.equal(r.length, 1);
});
test('computeInstants: DST — 08:00 local stays 08:00 local across US spring-forward', () => {
  const r = computeInstants({ schedule: sched({ schedule_type: 'times', times_local: ['08:00'] }), medicine: {}, timezone: 'America/New_York',
    from: new Date('2026-03-07T00:00:00Z'), to: new Date('2026-03-10T00:00:00Z') });
  assert.deepEqual(r.map((d) => d.toISOString()), ['2026-03-07T13:00:00.000Z', '2026-03-08T12:00:00.000Z', '2026-03-09T12:00:00.000Z']);
});
test('computeInstants: nonexistent DST local time (02:30 on spring-forward day) yields one valid instant', () => {
  const r = computeInstants({ schedule: sched({ schedule_type: 'times', times_local: ['02:30'] }), medicine: {}, timezone: 'America/New_York',
    from: new Date('2026-03-08T00:00:00Z'), to: new Date('2026-03-09T00:00:00Z') });
  assert.equal(r.length, 1);
});
