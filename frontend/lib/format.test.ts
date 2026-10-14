import assert from "node:assert/strict";
import test from "node:test";

import { formatBytes, formatDateTime, formatDeadline, formatDuration, formatPercent, formatRelativeDate } from "./format";

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

test("a moment reads whole, with its year and its time, whatever day it is now", () => {
  assert.equal(formatDateTime(new Date(2026, 9, 8, 10, 4)), "8 okt 2026 10:04");
  assert.equal(formatDateTime(new Date(2025, 2, 3, 8, 0).toISOString()), "3 mars 2025 08:00");
  assert.equal(formatDateTime("inte ett datum"), "");
});

test("durations read as seconds under a minute, then minutes, then hours and minutes, each one line long", () => {
  // A line never ends between a number and its unit, nor between an hour and its minutes.
  assert.equal(formatDuration(0), `0${nbsp}s`);
  assert.equal(formatDuration(22_400), `22${nbsp}s`);
  assert.equal(formatDuration(60_000), `1${nbsp}min`);
  assert.equal(formatDuration(32 * 60_000 + 10_000), `32${nbsp}min`);
  assert.equal(formatDuration(25 * 3_600_000), `1${nbsp}dygn${nbsp}1${nbsp}h`, "a day and more in days and hours, not in hundreds of hours");
  assert.equal(formatDuration((263 * 60 + 33) * 60_000), `10${nbsp}dygn${nbsp}23${nbsp}h`);
  assert.equal(formatDuration(48 * 3_600_000), `2${nbsp}dygn`);
  assert.equal(formatDuration(65 * 60_000), `1${nbsp}h${nbsp}5${nbsp}min`);
  assert.equal(formatDuration(119 * 60_000 + 40_000), `1${nbsp}h${nbsp}59${nbsp}min`, "what has passed, never more");
  assert.equal(formatDuration(3 * 3_600_000), `3${nbsp}h`);
});

test("a recording's length counts whole seconds, and its seconds under ten minutes, so every view says what the player shows", () => {
  // The ready view and the unsent-recordings card both show this recording; the timer stopped at 0:40.
  assert.equal(formatDuration(40_600), `40${nbsp}s`);
  assert.equal(formatDuration(59_600), `59${nbsp}s`);
  // The player beside it says 1:47.
  assert.equal(formatDuration(107_400), `1${nbsp}min${nbsp}47${nbsp}s`);
  assert.equal(formatDuration(9 * 60_000 + 59_900), `9${nbsp}min${nbsp}59${nbsp}s`);
  // From ten minutes the seconds are noise beside the length.
  assert.equal(formatDuration(10 * 60_000 + 30_000), `10${nbsp}min`);
});

test("a percentage is whole and has a space before its sign, which keeps it with the number", () => {
  assert.equal(formatPercent(0), `0${nbsp}%`);
  assert.equal(formatPercent(33), `33${nbsp}%`);
  assert.equal(formatPercent(100), `100${nbsp}%`);
});
