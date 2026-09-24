import assert from "node:assert/strict";
import test from "node:test";

import { formatBytes, formatDeadline, formatDuration, formatRelativeDate } from "./format";

const nbsp = " ";

test("sizes use a decimal comma, one decimal, and keep the unit with the number", () => {
  assert.equal(formatBytes(0), `0${nbsp}B`);
  assert.equal(formatBytes(532), `532${nbsp}B`);
  assert.equal(formatBytes(13_619), `13,3${nbsp}kB`);
  assert.equal(formatBytes(87_859), `85,8${nbsp}kB`);
  assert.equal(formatBytes(1_258_291), `1,2${nbsp}MB`);
  // Eneo's limits are whole mebibytes; they read without a trailing ",0".
  assert.equal(formatBytes(100 * 1024 * 1024), `100${nbsp}MB`);
  assert.equal(formatBytes(3 * 1024 ** 3), `3${nbsp}GB`);
});

test("relative dates say i dag and i går, otherwise the date, and the year only when it differs", () => {
  const now = new Date(2026, 8, 23, 16, 30);
  assert.equal(formatRelativeDate(new Date(2026, 8, 23, 10, 12), now), "i dag 10:12");
  assert.equal(formatRelativeDate(new Date(2026, 8, 22, 15, 40), now), "i går 15:40");
  assert.equal(formatRelativeDate(new Date(2026, 8, 21, 9, 5), now), "21 sep 09:05");
  assert.equal(formatRelativeDate(new Date(2026, 2, 3, 8, 0), now), "3 mars 08:00");
  assert.equal(formatRelativeDate(new Date(2025, 11, 12, 14, 0), now), "12 dec 2025");
  // Yesterday across a month boundary is still "i går".
  assert.equal(formatRelativeDate(new Date(2026, 8, 30, 23, 50), new Date(2026, 9, 1, 0, 10)), "i går 23:50");
  assert.equal(formatRelativeDate(new Date(2026, 8, 23, 10, 12).toISOString(), now), "i dag 10:12");
  assert.equal(formatRelativeDate("inte ett datum", now), "");
});

test("a deadline always says its time, in another year too", () => {
  const now = new Date(2026, 11, 20, 16, 30);
  assert.equal(formatDeadline(new Date(2026, 11, 20, 23, 59), now), "i dag 23:59");
  assert.equal(formatDeadline(new Date(2026, 11, 29, 9, 1), now), "29 dec 09:01");
  assert.equal(formatDeadline(new Date(2027, 0, 3, 9, 1), now), "3 jan 2027 09:01");
  assert.equal(formatDeadline("inte ett datum", now), "");
});

test("durations read as seconds under a minute, then minutes, then hours and minutes", () => {
  assert.equal(formatDuration(0), "0 s");
  assert.equal(formatDuration(22_400), "22 s");
  assert.equal(formatDuration(60_000), "1 min");
  assert.equal(formatDuration(32 * 60_000 + 10_000), "32 min");
  assert.equal(formatDuration(65 * 60_000), "1 h 5 min");
  assert.equal(formatDuration(119 * 60_000 + 40_000), "2 h");
  assert.equal(formatDuration(3 * 3_600_000), "3 h");
});

test("a recording's length counts whole seconds, so every view shows the same one", () => {
  // The ready view and the unsent-recordings card both show this recording; the timer stopped at 0:40.
  assert.equal(formatDuration(40_600), "40 s");
  assert.equal(formatDuration(59_600), "59 s");
});
