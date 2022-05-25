import {
  getStore,
  getWsClient,
  isDevMode,
  debounce,
  throttle,
} from "./utils.js"
import { detectData, detectSessionId } from "./detectData.js"

const WebSocket = getWsClient()
const store = getStore()

// Options that can be changed by the user
let endpoint = "wss://app.nucleus.sh"
let useInDev = true
let debug = false
let trackingOff = false
let reportInterval = 20

// All the stuff we'll need later globally
let ws = null
let localData = {}

let queue = store.get("nucleus-queue") || []
let props = store.get("nucleus-props") || {}

const track = (name, data = undefined, type = "event") => {
  if (!name && !type) return
  if (trackingOff || (isDevMode() && !useInDev)) return

  log("adding to queue: " + (name || type))

  // An ID for the event so when the server returns it we know it was reported
  const tempId = Math.floor(Math.random() * 1e6) + 1

  if (type === "init" && props) data = props

  const { sessionId } = localData

  const eventData = {
    type,
    name,
    id: tempId,
    date: new Date(),
    payload: data,
    sessionId,
  }

  queue.push(eventData)
}

const completeEvents = (events) => {
  return events.map((event) => {
    const { type } = event
    const { userId, machineId } = localData

    let newEvent = {
      ...event,
      userId,
      machineId,
    }

    // So we don't send unnecessary data when not needed
    // (= first event, and on error)
    if (type && ["init", "error"].includes(type)) {
      const { platform, osVersion, version, locale, moduleVersion } = localData

      const extra = {
        client: "js",
        platform,
        osVersion,
        version,
        locale,
        moduleVersion,
      }

      newEvent = { ...newEvent, ...extra }
    }

    return newEvent
  })
}

const Nucleus = {
  // not arrow function for access to this
  init: function (appId, options = {}) {
    useInDev = !options.disableInDev
    debug = !!options.debug
    trackingOff = !!options.disableTracking

    if (options.endpoint) endpoint = options.endpoint
    if (options.reportInterval) reportInterval = options.reportInterval

    if (!appId) return console.error("Nucleus: missing app ID")

    localData = { ...detectSessionId(), appId }

    // don't track session start if we already did
    if (!localData.existingSession) {
      track(null, null, "init")
    }

    if (!options.disableErrorReports && typeof process !== "undefined") {
      process.on("uncaughtException", (err) => {
        this.trackError("uncaughtException", err)
      })

      process.on("unhandledRejection", (err) => {
        this.trackError("unhandledRejection", err)
      })
    }

    // Only if we are in a browser or renderer process
    if (typeof window !== "undefined") {
      if (!options.disableErrorReports) {
        window.onerror = (message, file, line, col, err) => {
          this.trackError("windowError", err)
        }
      }

      // Automatically send data when back online
      window.addEventListener("online", reportData)
    }

    detectData().then((detectedData) => {
      localData = { ...localData, ...detectedData }

      const undetectedProps = Object.keys(localData).filter(
        (prop) => !localData[prop]
      )

      if (undetectedProps.length) {
        logWarn(
          `Some properties couldn't be detected: ${undetectedProps.join(
            ","
          )}. Set them manually or data will be missing in the dashboard.`
        )
      }

      if (isDevMode() && !useInDev)
        return log("in dev mode, not reporting data anything")

      // Make sure we stay in sync
      // And save regularly to disk the latest events
      // Keeps realtime dashboard updated too

      setInterval(reportData, reportInterval * 1000)
      reportData()
    })
  },

  track: throttle(track, 50),

  // Not arrow for this
  trackError: function (name, err) {
    if (!err) return
    // Convert Error to normal object, so we can stringify it
    const errObject = {
      stack: err.stack || err,
      message: err.message || err,
    }

    this.track(name, errObject, "error")
  },

  // So we can follow this user actions
  setUserId: function (newId) {
    if (!newId || newId.trim() === "") return false

    log("user id set to " + newId)

    localData.userId = newId

    // only send event if we didn't init, else will be passed with init
    this.track(null, null, "userid")
  },

  // Allows to set custom properties to users
  setProps: function (newProps, overwrite) {
    // If it's part of the localData object overwrite there
    for (const prop in newProps) {
      if (localData[prop]) {
        localData[prop] = newProps[prop]
        newProps[prop] = null
      }
    }

    // Merge past and new props
    if (!overwrite) props = Object.assign(props, newProps)
    else props = newProps

    save("props", props)

    // only send event if we didn't init, else will be passed with init
    this.track(null, props, "props")
  },

  // Allows for setting both setting user and properties at the same time
  identify: function (newId, newProps) {
    this.setUserId(newId)
    this.setProps(newProps, true)
  },

  // Allows for tracking of pages users are visiting
  page: function (name, params) {
    if (!name || name.trim() === "") {
      if (typeof window !== "undefined") {
        name = window.location.pathname
      } else {
        return false
      }
    }

    log("viewing screen " + name)

    this.track(name, params, "nucleus:view")
  },

  // alias for page
  screen: function (name, params) {
    this.page(name, params)
  },

  disableTracking: () => {
    trackingOff = true
    log("tracking disabled")
  },

  enableTracking: () => {
    trackingOff = false
    log("tracking enabled")
  },
}

const sendQueue = () => {
  // Connection not opened?
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    // persists current queue in case app is closed before sync
    save("queue", queue)
    return
  }

  log(`sending cached events (${queue.length})`)

  // if nothing to report, send a heartbeat anyway
  // only machine id is needed to derive the other infos server-side

  const data = queue.length
    ? completeEvents(queue)
    : [
        {
          type: "heartbeat",
          machineId: localData.machineId,
        },
      ]

  const payload = JSON.stringify({ data })
  ws.send(payload)
}

// Try to report the data to the server
const reportData = () => {
  // remove events older than 48 hours
  const cutoff = new Date().getTime() - 48 * 60 * 60 * 1000
  queue = queue.filter((event) => new Date(event.date).getTime() > cutoff)
  save("queue", queue)

  if (trackingOff) return

  // If socket was closed for whatever reason re-open it
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log("No connection to server. Opening it.")

    ws = new WebSocket(`${endpoint}/app/${localData.appId}/track`)

    ws.onerror = (e) => {
      logWarn(`ws ${e.code}: ${e.reason}`)
    }

    ws.onclose = (e) => {
      logWarn(`ws ${e.code}: ${e.reason}`)
    }

    ws.onmessage = messageFromServer

    ws.onopen = sendQueue
  }

  sendQueue()
}

// Received a message from the server
const messageFromServer = (message) => {
  let data = {}

  log("server said " + message.data)

  try {
    data = JSON.parse(message.data)
  } catch (e) {
    logWarn("Could not parse message from server.")
    return
  }

  if (data.reportedIds || data.confirmation) {
    // Data was successfully reported, we can empty the queue
    log("Server successfully registered our data.")

    if (data.reportedIds)
      queue = queue.filter((e) => !data.reportedIds.includes(e.id))
    else if (data.confirmation) queue = [] // Legacy handling

    save("queue", queue)
  }
}

const save = debounce(
  (what, data) => {
    store.set("nucleus-" + what, data)
  },
  500,
  true
)

const log = (msg) => {
  if (debug) console.log("Nucleus: " + msg)
}

const logWarn = (msg) => {
  if (debug) console.warn("Nucleus warning: " + msg)
}

export default Nucleus
