// The page's own cache in IndexedDB (DB "claude-slack-web"), so a reload shows what it had at once and a
// picture is fetched once. Everything here may fail (private mode, storage cleared, quota): callers treat a
// miss and an error the same, and the page works without it.
const DB = 'claude-slack-web'
const IMAGES_MAX = 300
const THREADS_MAX = 30
const EVENTS_MAX = 3000

let dbp = null
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => {
      const d = req.result
      d.createObjectStore('images').createIndex('at', 'at')
      d.createObjectStore('timeline').createIndex('at', 'at')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }).catch(() => null)
  return dbp
}
function tx(store, mode, fn) {
  return db().then(
    (d) =>
      d &&
      new Promise((resolve) => {
        try {
          const t = d.transaction(store, mode)
          const out = fn(t.objectStore(store))
          t.oncomplete = () => resolve(out?.result ?? out)
          t.onerror = t.onabort = () => resolve(undefined)
        } catch {
          resolve(undefined)
        }
      }),
  )
}

/** Drop the oldest entries of a store beyond `max`. */
async function prune(store, max) {
  await tx(store, 'readwrite', (s) => {
    const count = s.count()
    count.onsuccess = () => {
      let extra = count.result - max
      if (extra <= 0) return
      s.index('at').openCursor().onsuccess = (e) => {
        const c = e.target.result
        if (!c || extra-- <= 0) return
        c.delete()
        c.continue()
      }
    }
  })
}

/** A picture by key (`<thread>:<content hash>`), as a Blob. */
export async function getImage(key) {
  const v = await tx('images', 'readonly', (s) => s.get(key))
  return v?.blob
}
export async function putImage(key, blob) {
  await tx('images', 'readwrite', (s) => s.put({ blob, at: Date.now() }, key))
  prune('images', IMAGES_MAX)
}

/**
 * A session's recent events, so a reload draws them before the network answers. Large inline pictures
 * are replaced by their reference: the cache holds the conversation, not its bytes.
 */
export async function saveTimeline(thread, events) {
  const slim = events.slice(-EVENTS_MAX).map((ev) => {
    if (!ev.images?.some((im) => im.data && im.data.length > 50_000)) return ev
    const strip = (list) => list.map((im) => (im.data && im.data.length > 50_000 ? { ...im, data: undefined, src: `/api/image/${thread}/${im.id}` } : im))
    return { ...ev, images: strip(ev.images) }
  })
  await tx('timeline', 'readwrite', (s) => s.put({ events: slim, at: Date.now() }, thread))
  prune('timeline', THREADS_MAX)
}
export async function loadTimeline(thread) {
  const v = await tx('timeline', 'readonly', (s) => s.get(thread))
  return v?.events ?? []
}
