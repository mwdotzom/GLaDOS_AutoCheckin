// Runtime test harness for background.js: loads it in a vm with a stubbed
// browser API and asserts the check-in protocol that the site requires.
// Run: node scripts/test-background.mjs
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import vm from "node:vm"
import assert from "node:assert/strict"
import { webcrypto } from "node:crypto"

const code = readFileSync(new URL("../background.js", import.meta.url), "utf8")

const ORIGIN = "https://glados.rocks"
const CHALLENGE = `${ORIGIN}/api/user/checkin/challenge`
const CHECKIN = `${ORIGIN}/api/user/checkin`
const SALT = "glados-observe-v1"

const sha256 = (text) => createHash("sha256").update(text).digest("hex")

/**
 * @param {object} opts
 * @param {number} opts.hour              local hour used by the targetHour gate
 * @param {object} opts.challenge         challenge endpoint payload
 * @param {object} opts.checkin           checkin endpoint payload
 * @param {number[]} opts.checkinStatuses sequence of HTTP statuses before success
 */
function makeHarness({
  hour = 10,
  existingAlarm = null,
  challenge = { code: 0, nonce: "nonce-abc-123", ttl: 300000 },
  checkin = { code: 0, message: "Checkin! Got 100 points", points: 100, streak: 3 },
  checkinStatuses = null,
  challengeError = null,
  checkinError = null
} = {}) {
  const calls = { created: 0, fetched: [], notifications: [], rules: 0, opened: 0, sleeps: [] }
  let store = { notifyEnabled: true, targetHour: 9 }
  let alarmState = existingAlarm
  let checkinAttempts = 0
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
        if (alarmState?.name === name) alarmState = null
        return Promise.resolve(true)
      },
      get: (name) => Promise.resolve(alarmState?.name === name ? alarmState : undefined),
      onAlarm: { addListener: (f) => (listeners.alarm = f) }
    },
    storage: {
      local: {
        get: async (req) => {
          if (Array.isArray(req))
            return Object.fromEntries(req.filter((k) => k in store).map((k) => [k, store[k]]))
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
      updateDynamicRules: async (arg) => {
        calls.rules++
        calls.lastRuleArg = arg
      }
    },
    action: { onClicked: { addListener: (f) => (listeners.action = f) } }
  }

  const RealDate = Date
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super()
        super.setHours(hour, 5, 0, 0)
      } else super(...args)
    }
    static now() {
      return new FakeDate().getTime()
    }
  }

  const fetchStub = async (url, opts = {}) => {
    calls.fetched.push({ url, method: opts.method || "GET", body: opts.body, headers: opts.headers })
    if (url === CHALLENGE) {
      if (challengeError) throw new TypeError(challengeError)
      return { ok: true, status: 200, text: async () => JSON.stringify(challenge) }
    }
    if (url === CHECKIN) {
      checkinAttempts++
      if (checkinError) throw new TypeError(checkinError)
      const statuses = checkinStatuses || []
      const status = statuses[checkinAttempts - 1] ?? 200
      if (status !== 200)
        return { ok: false, status, text: async () => `upstream ${status}` }
      return { ok: true, status: 200, text: async () => JSON.stringify(checkin) }
    }
    throw new Error("unexpected url " + url)
  }

  // Immediate timers keep the 2500ms pacing instant while still recording it.
  const setTimeoutStub = (fn, ms) => {
    calls.sleeps.push(ms)
    fn()
    return 0
  }

  const ctx = vm.createContext({
    browser,
    chrome: undefined,
    fetch: fetchStub,
    console: { log() {}, error() {} },
    Date: FakeDate,
    setTimeout: setTimeoutStub,
    crypto: webcrypto,
    TextEncoder,
    AbortSignal,
    JSON,
    String,
    Object,
    Promise,
    Array,
    Number,
    Math,
    Error,
    Boolean,
    RegExp,
    Uint8Array,
    parseFloat,
    isFinite
  })
  vm.runInContext(code, ctx)

  return {
    ctx,
    calls,
    listeners,
    store: () => store,
    alarm: () => alarmState,
    fireAlarm: () => listeners.alarm({ name: "checkInAlarm" }),
    otherAlarm: () => listeners.alarm({ name: "somethingElse" }),
    checkinBody: () => {
      const post = calls.fetched.find((f) => f.url === CHECKIN && f.method === "POST")
      return post ? JSON.parse(post.body) : null
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const settle = async () => {
  await sleep(20)
  await sleep(20)
}

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

// ---------------------------------------------------------------- scheduling
await check("onStartup re-creates the missing alarm", async () => {
  const h = makeHarness()
  h.listeners.startup()
  await settle()
  assert.equal(h.calls.created, 1)
  assert.equal(h.alarm().name, "checkInAlarm")
  assert.equal(h.alarm().periodInMinutes, 60)
  assert.equal(h.calls.rules, 1, "header rules re-registered on startup")
})

await check("alarm handler keeps exactly one alarm", async () => {
  const h = makeHarness({ existingAlarm: { name: "checkInAlarm", periodInMinutes: 60 } })
  h.fireAlarm()
  await settle()
  assert.equal(h.calls.created, 0)
  assert.equal(h.calls.fetched.filter((f) => f.url === CHECKIN).length, 1)
})

await check("alarm handler repairs a lost alarm", async () => {
  const h = makeHarness()
  h.fireAlarm()
  await settle()
  assert.equal(h.calls.created, 1)
})

await check("unrelated alarm name does nothing", async () => {
  const h = makeHarness()
  h.otherAlarm()
  await settle()
  assert.equal(h.calls.fetched.length, 0)
})

await check("hour before targetHour skips the request but keeps the alarm", async () => {
  const h = makeHarness({ hour: 3 })
  h.listeners.startup()
  await settle()
  assert.equal(h.calls.fetched.length, 0)
  assert.equal(h.calls.created, 1)
})

// ---------------------------------------------------------------- protocol
await check("challenge is fetched before the checkin POST", async () => {
  const h = makeHarness()
  h.listeners.installed()
  await settle()
  const urls = h.calls.fetched.map((f) => `${f.method} ${f.url}`)
  assert.deepEqual(urls, [`GET ${CHALLENGE}`, `POST ${CHECKIN}`])
})

await check("POST carries token + nonce + proof + tsState", async () => {
  const h = makeHarness()
  h.listeners.installed()
  await settle()
  const body = h.checkinBody()
  assert.equal(body.token, "glados.rocks")
  assert.equal(body.nonce, "nonce-abc-123")
  assert.equal(body.tsState, "off", "no turnstile in the challenge")
  assert.match(body.proof, /^[0-9a-f]{64}$/)
})

await check("proof is SHA-256(nonce.salt) hex", async () => {
  const h = makeHarness()
  h.listeners.installed()
  await settle()
  assert.equal(h.checkinBody().proof, sha256(`nonce-abc-123.${SALT}`))
})

await check("waits at least 2500ms after the challenge", async () => {
  const h = makeHarness()
  h.listeners.installed()
  await settle()
  assert.ok(
    h.calls.sleeps.some((ms) => ms >= 2500),
    `no >=2500ms wait recorded: ${JSON.stringify(h.calls.sleeps)}`
  )
})

await check("challenge without nonce aborts before any POST", async () => {
  const h = makeHarness({ challenge: { code: 0 } })
  h.listeners.installed()
  await settle()
  assert.equal(h.calls.fetched.filter((f) => f.url === CHECKIN).length, 0)
  assert.match(h.store().history[0].result, /未能获取签到挑战/)
})

await check("unauthenticated challenge reports the login requirement", async () => {
  const h = makeHarness({ challenge: { code: -2, message: "没有权限" } })
  h.listeners.installed()
  await settle()
  assert.equal(h.calls.fetched.filter((f) => f.url === CHECKIN).length, 0)
  assert.match(h.store().history[0].result, /重新登录/)
  assert.equal(h.store().lastCheckInDate, undefined)
})

await check("turnstile challenge sends tsState=timeout and asks for manual", async () => {
  const h = makeHarness({
    challenge: { code: 0, nonce: "n2", ttl: 300000, turnstile: { sitekey: "x" } },
    checkin: { code: 1, message: "需要人机验证", reason: "turnstile" }
  })
  h.listeners.installed()
  await settle()
  assert.equal(h.checkinBody().tsState, "timeout")
  assert.match(h.store().history[0].result, /手动签到/)
  assert.match(h.calls.notifications[0].title, /手动签到/)
  assert.equal(h.store().lastCheckInDate, undefined)
})

await check("device-mismatch is surfaced, not treated as success", async () => {
  const h = makeHarness({
    checkin: { code: 4, message: "device mismatch", reason: "device-mismatch" }
  })
  h.listeners.installed()
  await settle()
  assert.match(h.store().history[0].result, /设备不一致/)
  assert.equal(h.store().lastCheckInDate, undefined)
})

await check("successful checkin records points and the day", async () => {
  const h = makeHarness()
  h.listeners.installed()
  await settle()
  assert.match(h.store().history[0].result, /签到成功/)
  assert.match(h.store().history[0].result, /获得 100 积分/)
  assert.match(h.store().history[0].result, /连签 3 天/)
  assert.ok(h.store().lastCheckInDate, "marker written")
})

await check("already-checked-in reply counts as done", async () => {
  const h = makeHarness({
    checkin: { code: 0, message: "Checkin Repeats! Please Try Tomorrow", repeated: true }
  })
  h.listeners.installed()
  await settle()
  assert.match(h.store().history[0].result, /今日已签到/)
  assert.ok(h.store().lastCheckInDate)
})

await check("later alarms stay quiet once the day is marked", async () => {
  const h = makeHarness()
  h.listeners.installed()
  await settle()
  const before = h.calls.fetched.length
  h.fireAlarm()
  await settle()
  assert.equal(h.calls.fetched.length, before)
})

// ---------------------------------------------------------------- failure paths
await check("5xx is retried, then succeeds", async () => {
  const h = makeHarness({ checkinStatuses: [503, 200] })
  h.listeners.installed()
  await settle()
  assert.equal(h.calls.fetched.filter((f) => f.url === CHECKIN).length, 2)
  assert.ok(h.store().lastCheckInDate)
})

await check("network failure leaves lastCheckInDate unset and notifies", async () => {
  const h = makeHarness({ challengeError: "network down" })
  h.listeners.installed()
  await settle()
  assert.equal(h.calls.fetched.filter((f) => f.url === CHECKIN).length, 0)
  assert.equal(h.store().lastCheckInDate, undefined)
  assert.equal(h.calls.notifications.length, 1)
})

await check("manual success sets lastCheckInDate", async () => {
  const h = makeHarness({ hour: 15 })
  const reply = await h.listeners.message({ action: "forceCheckIn" })
  assert.equal(reply.status, "done")
  assert.equal(reply.ok, true)
  assert.ok(h.store().lastCheckInDate)
})

await check("manual failure does not set the day", async () => {
  const h = makeHarness({
    hour: 15,
    checkin: { code: 1003, message: "未登录" }
  })
  const reply = await h.listeners.message({ action: "forceCheckIn" })
  assert.equal(reply.ok, false)
  assert.equal(h.store().lastCheckInDate, undefined)
})

await check("marker uses the local calendar date", async () => {
  const h = makeHarness({ hour: 23 })
  h.listeners.installed()
  await settle()
  assert.match(h.store().lastCheckInDate, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(h.store().lastCheckInDate, vm.runInContext("localToday()", h.ctx))
})

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
