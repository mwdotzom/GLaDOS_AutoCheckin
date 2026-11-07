// Runtime test harness for background.js: loads it in a vm with a stubbed
// browser API and asserts the scheduling behaviour that regressed.
// Run: node scripts/test-background.mjs
import { readFileSync } from "node:fs"
import vm from "node:vm"
import assert from "node:assert/strict"

const code = readFileSync(new URL("../background.js", import.meta.url), "utf8")

function makeHarness({
  hour = 10,
  existingAlarm = null,
  response = { code: 0, message: "Checkin! Got 100 points" },
  fetchError = null
} = {}) {
  const calls = { created: 0, cleared: 0, fetched: [], notifications: [], rules: 0, opened: 0 }
  let store = { notifyEnabled: true, targetHour: 9 }
  let alarmState = existingAlarm
  const listeners = {}

  const browser = {
    runtime: {
      onInstalled: { addListener: (f) => (listeners.installed = f) },
      onStartup: { addListener: (f) => (listeners.startup = f) },
      onMessage: { addListener: (f) => (listeners.message = f) },
      openOptionsPage: () => calls.opened++,
      getURL: (p) => "moz-extension://abc/" + p
    },
    alarms: {
      create: (name, opts) => {
        calls.created++
        alarmState = { name, ...opts }
        return Promise.resolve()
      },
      clear: (name) => {
        calls.cleared++
        if (alarmState?.name === name) alarmState = null
        return Promise.resolve(true)
      },
      get: (name) => Promise.resolve(alarmState?.name === name ? alarmState : undefined),
      onAlarm: { addListener: (f) => (listeners.alarm = f) }
    },
    storage: {
      local: {
        get: async (req) => {
          if (Array.isArray(req)) return Object.fromEntries(req.filter((k) => k in store).map((k) => [k, store[k]]))
          if (req && typeof req === "object") {
            const out = { ...req }
            for (const k of Object.keys(req)) if (k in store) out[k] = store[k]
            return out
          }
          return { ...store }
        },
        set: async (obj) => Object.assign(store, obj)
      }
    },
    notifications: { create: async (o) => calls.notifications.push(o) },
    declarativeNetRequest: {
      updateDynamicRules: async () => {
        calls.rules++
      }
    },
    action: { onClicked: { addListener: (f) => (listeners.action = f) } }
  }

  // Freeze the local hour so the targetHour gate is deterministic.
  const RealDate = Date
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super()
        super.setHours(hour, 5, 0, 0)
      } else super(...args)
    }
    static now() {
      const d = new FakeDate()
      return d.getTime()
    }
  }

  const fetchStub = async (url, opts) => {
    calls.fetched.push({ url, opts })
    if (fetchError) throw new Error(fetchError)
    return { status: 200, json: async () => response }
  }

  const ctx = vm.createContext({
    browser,
    chrome: undefined,
    fetch: fetchStub,
    console: { log() {}, error() {} },
    Date: FakeDate,
    setTimeout,
    JSON,
    String,
    Object,
    Promise,
    Array,
    Number,
    Math,
    Error,
    Boolean,
    RegExp
  })
  vm.runInContext(code, ctx)

  return {
    ctx,
    calls,
    listeners,
    store: () => store,
    alarm: () => alarmState,
    fireAlarm: () => listeners.alarm({ name: "checkInAlarm" }),
    otherAlarm: () => listeners.alarm({ name: "somethingElse" })
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const settle = async () => { await sleep(20); await sleep(20) }

let failures = 0
async function check(name, fn) {
  try {
    await fn()
    console.log("PASS  " + name)
  } catch (error) {
    failures++
    console.log("FAIL  " + name + "\n      " + error.message)
  }
}

// 1. Startup must re-create the alarm: Firefox does not keep it across restarts.
await check("onStartup re-creates the missing alarm", async () => {
  const h = makeHarness()
  h.listeners.startup()
  await settle()
  assert.equal(h.calls.created, 1)
  assert.equal(h.alarm().name, "checkInAlarm")
  assert.equal(h.alarm().periodInMinutes, 60)
  assert.equal(h.alarm().delayInMinutes, 1)
  assert.equal(h.calls.rules, 1, "header rules re-registered on startup")
})

// 2. Install path still creates it once.
await check("onInstalled creates the alarm and checks immediately", async () => {
  const h = makeHarness()
  h.listeners.installed()
  await settle()
  assert.equal(h.calls.created, 1)
  assert.equal(h.calls.rules, 1)
  assert.equal(h.calls.fetched.length, 1)
  assert.equal(h.calls.fetched[0].url, "https://glados.rocks/api/user/checkin")
})

// 3. Alarm handler must not stack duplicates when the alarm already exists.
await check("alarm handler keeps exactly one alarm", async () => {
  const h = makeHarness({ existingAlarm: { name: "checkInAlarm", periodInMinutes: 60 } })
  h.fireAlarm()
  await settle()
  assert.equal(h.calls.created, 0, "no re-create while the alarm exists")
  assert.equal(h.calls.fetched.length, 1, "check-in still attempted")
})

// 4. A lost alarm is repaired by the next alarm callback.
await check("alarm handler repairs a lost alarm", async () => {
  const h = makeHarness()
  h.fireAlarm()
  await settle()
  assert.equal(h.calls.created, 1)
})

// 5. Unknown alarm names are ignored.
await check("unrelated alarm name does nothing", async () => {
  const h = makeHarness()
  h.otherAlarm()
  await settle()
  assert.equal(h.calls.fetched.length, 0)
})

// 6. Before the target hour, no request goes out.
await check("hour before targetHour skips the request", async () => {
  const h = makeHarness({ hour: 3 })
  h.listeners.startup()
  await settle()
  assert.equal(h.calls.fetched.length, 0)
  assert.equal(h.calls.created, 1, "but the alarm is still scheduled")
})

// 7. Once today's check-in is recorded, later alarms stay quiet.
await check("already-checked-in today sends no request", async () => {
  const h = makeHarness()
  const today = new (vm.runInContext("Date", h.ctx))()
  h.store().lastCheckInDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`
  h.fireAlarm()
  await settle()
  assert.equal(h.calls.fetched.length, 0)
})

// 8. Manual test now marks the day, so the auto path cannot repeat it.
await check("manual success sets lastCheckInDate", async () => {
  const h = makeHarness({ hour: 15 })
  const reply = await h.listeners.message({ action: "forceCheckIn" })
  // The object comes from another vm realm, so compare fields, not prototypes.
  assert.equal(reply.status, "done")
  assert.ok(h.store().lastCheckInDate, "marker written by manual run")
  assert.equal(h.calls.fetched.length, 1)
})

// 9. A not-logged-in reply must not mark the day.
await check("auth failure leaves lastCheckInDate unset", async () => {
  const h = makeHarness({ response: { code: 1003, message: "未登录" } })
  h.listeners.installed()
  await settle()
  assert.equal(h.calls.fetched.length, 1)
  assert.equal(h.store().lastCheckInDate, undefined)
})

// 10. Network error path leaves the marker alone but still records history.
await check("network failure leaves lastCheckInDate unset", async () => {
  const h = makeHarness({ fetchError: "navigator.onLine failure" })
  h.listeners.installed()
  await settle()
  assert.equal(h.calls.fetched.length, 1)
  assert.equal(h.store().lastCheckInDate, undefined)
  assert.equal(h.calls.notifications.length, 1, "failure is still reported")
  assert.equal(h.store().history[0].result, "[自动] 网络连接失败")
})

// 11. Marker date is local, not UTC.
await check("marker uses the local calendar date", async () => {
  const h = makeHarness({ hour: 23 })
  h.listeners.installed()
  await settle()
  const expected = vm.runInContext("localToday()", h.ctx)
  assert.equal(h.store().lastCheckInDate, expected)
  assert.match(h.store().lastCheckInDate, /^\d{4}-\d{2}-\d{2}$/)
})
