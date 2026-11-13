// "After 7 PM goes to the next day": one rule for every queue (Confirm, Pending, NDR ...). Pure functions, all times IST.
// An entry whose due time lands at or after CUTOFF_HOUR is not due that evening: it opens the next day at RESUME_HOUR.
// Change the two numbers here to move the cut-off or the morning start.
const { istParts, istToDate } = require('./istTime');

const CUTOFF_HOUR = 19; // 7 PM
const RESUME_HOUR = 9; // 9 AM next day

// The first moment of the next IST day at the resume hour.
function nextDayStart(date) {
  const p = istParts(date);
  return istToDate(p.y, p.m, p.d + 1, RESUME_HOUR, 0);
}

// A due time that falls at or after 7 PM (IST) moves to 9 AM the next day. Anything earlier is returned unchanged.
function deferAfterHours(date) {
  if (!date) return date;
  const d = new Date(date);
  return istParts(d).h >= CUTOFF_HOUR ? nextDayStart(d) : d;
}

module.exports = { CUTOFF_HOUR, RESUME_HOUR, nextDayStart, deferAfterHours };
