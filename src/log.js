// Nhật ký sự kiện, lưu trong chrome.storage.local để side panel hiển thị dạng terminal.
// KHÔNG bao giờ ghi giá trị token vào log.

export const LOG_KEY = "logs";
export const MAX_LOGS = 300;
export const LEVELS = ["info", "success", "warn", "error", "debug"];

// Ghi tuần tự để các dòng log không ghi đè nhau.
let queue = Promise.resolve();

export function log(level, message) {
  const entry = {
    t: Date.now(),
    level: LEVELS.includes(level) ? level : "info",
    msg: String(message),
  };
  const run = queue.then(async () => {
    const { [LOG_KEY]: logs = [] } = await chrome.storage.local.get(LOG_KEY);
    logs.push(entry);
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
    await chrome.storage.local.set({ [LOG_KEY]: logs });
  });
  queue = run.catch(() => {});
  return run;
}

export const logInfo = (m) => log("info", m);
export const logSuccess = (m) => log("success", m);
export const logWarn = (m) => log("warn", m);
export const logError = (m) => log("error", m);
export const logDebug = (m) => log("debug", m);

export async function getLogs() {
  const { [LOG_KEY]: logs = [] } = await chrome.storage.local.get(LOG_KEY);
  return logs;
}

export async function clearLogs() {
  await queue;
  await chrome.storage.local.set({ [LOG_KEY]: [] });
}

/** Định dạng giờ HH:MM:SS (và ngày nếu khác hôm nay). */
export function formatTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? time
    : `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${time}`;
}

export function formatLine(e) {
  return `[${formatTime(e.t)}] ${e.level.toUpperCase().padEnd(7)} ${e.msg}`;
}
