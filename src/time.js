'use strict';

const TIME_ZONE = process.env.STORE_TIMEZONE || 'Asia/Taipei';

const formatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
});

/** Current local time in the store's time zone, "YYYY-MM-DD HH:mm:ss". */
function nowLocal(date = new Date()) {
  return formatter.format(date).replace('T', ' ');
}

/** Current local date in the store's time zone, "YYYY-MM-DD". */
function todayLocal(date = new Date()) {
  return nowLocal(date).slice(0, 10);
}

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

module.exports = { TIME_ZONE, nowLocal, todayLocal, isValidDate };
