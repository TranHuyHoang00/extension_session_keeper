// Giả lập tối thiểu các API chrome.* để test logic của background.js bằng Node.

const event = () => {
  const ls = [];
  return { addListener: (f) => ls.push(f), listeners: ls };
};

export function makeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
}

export function createChromeMock() {
  const db = {
    sync: {},
    local: {},
    cookies: {},      // name -> value
    alarms: {},       // name -> when
    tabs: [],         // {id, url, active, windowId}
    reloaded: [],
    removedTabs: [],
    notifications: [],
    badge: "",
    pageState: { captcha: false, login: false, path: "/" },
    nextTabId: 100,
    granted: true,
  };

  const storageArea = (name) => ({
    get: async (key) => (key in db[name] ? { [key]: structuredClone(db[name][key]) } : {}),
    set: async (obj) => Object.assign(db[name], structuredClone(obj)),
  });

  const chrome = {
    storage: { sync: storageArea("sync"), local: storageArea("local"), onChanged: event() },
    alarms: {
      create: async (name, { when }) => { db.alarms[name] = when; },
      clear: async (name) => { delete db.alarms[name]; return true; },
      onAlarm: event(),
    },
    cookies: {
      get: async ({ name }) => (name in db.cookies ? { name, value: db.cookies[name] } : null),
      onChanged: event(),
    },
    permissions: { contains: async () => db.granted },
    tabs: {
      query: async ({ url }) => db.tabs.filter((t) => t.url.startsWith(url.replace("/*", ""))),
      create: async ({ url, active }) => {
        const t = { id: db.nextTabId++, url, active: !!active, windowId: 1 };
        db.tabs.push(t);
        return t;
      },
      reload: async (id) => { db.reloaded.push(id); },
      update: async (id) => db.tabs.find((t) => t.id === id),
      get: async (id) => {
        const t = db.tabs.find((x) => x.id === id);
        if (!t) throw new Error("No tab");
        return t;
      },
      remove: async (id) => {
        db.tabs = db.tabs.filter((t) => t.id !== id);
        db.removedTabs.push(id);
      },
      onRemoved: event(),
    },
    windows: { update: async () => {} },
    scripting: { executeScript: async () => [{ result: db.pageState }] },
    action: {
      setBadgeText: async ({ text }) => { db.badge = text; },
      setBadgeBackgroundColor: async () => {},
    },
    notifications: {
      create: async (id, opts) => { db.notifications.push(opts.message); },
      clear: async () => {},
      onClicked: event(),
    },
    runtime: {
      onInstalled: event(),
      onStartup: event(),
      onMessage: event(),
      openOptionsPage: () => {},
      getURL: (p) => "chrome-extension://x/" + p,
    },
  };
  return { chrome, db };
}
