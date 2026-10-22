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
    cookies: {}, // origin -> { name: value }
    alarms: {}, // name -> when
    tabs: [], // {id, url, active, windowId}
    reloaded: [],
    removedTabs: [],
    notifications: [], // { id, title, message }
    tabBadges: {},
    created: [],
    panelOptions: [],
    panelOpened: [],
    panelBehavior: null,
    pageState: { captcha: false, login: false, path: "/" },
    nextTabId: 100,
    granted: true,
  };

  const storageArea = (name) => ({
    get: async (keys) => {
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in db[name]) out[k] = structuredClone(db[name][k]);
      return out;
    },
    set: async (obj) => Object.assign(db[name], structuredClone(obj)),
    remove: async (keys) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete db[name][k];
    },
  });

  const chrome = {
    storage: { sync: storageArea("sync"), local: storageArea("local"), onChanged: event() },
    alarms: {
      create: async (name, { when }) => {
        db.alarms[name] = when;
      },
      clear: async (name) => {
        delete db.alarms[name];
        return true;
      },
      clearAll: async () => {
        db.alarms = {};
        return true;
      },
      onAlarm: event(),
    },
    cookies: {
      get: async ({ url, name }) => {
        const jar = db.cookies[new URL(url).origin] || {};
        return name in jar ? { name, value: jar[name] } : null;
      },
      onChanged: event(),
    },
    permissions: { contains: async () => db.granted },
    tabs: {
      query: async () => db.tabs,
      create: async ({ url, active }) => {
        const t = { id: db.nextTabId++, url, active: !!active, windowId: 1 };
        db.tabs.push(t);
        db.created.push(t.id);
        return t;
      },
      reload: async (id) => {
        db.reloaded.push(id);
      },
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
      onUpdated: event(),
    },
    windows: { update: async () => {} },
    scripting: { executeScript: async () => [{ result: db.pageState }] },
    sidePanel: {
      setPanelBehavior: async (b) => {
        db.panelBehavior = b;
      },
      setOptions: async (o) => {
        db.panelOptions.push(o);
      },
      open: async (o) => {
        db.panelOpened.push(o.tabId);
      },
    },
    action: {
      onClicked: event(),
      setBadgeText: async ({ tabId, text }) => {
        db.tabBadges[tabId] = text;
      },
      setBadgeBackgroundColor: async () => {},
    },
    notifications: {
      create: async (id, opts) => {
        db.notifications.push({ id, title: opts.title, message: opts.message });
      },
      clear: async () => {},
      onClicked: event(),
    },
    runtime: {
      onInstalled: event(),
      onStartup: event(),
      onMessage: event(),
      getURL: (p) => "chrome-extension://x/" + p,
    },
  };
  return { chrome, db };
}
