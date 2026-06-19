# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`@jcbuisson/express-x-client` is the browser-side client library for the ExpressX framework. It wraps a socket.io socket and provides service proxies, pub/sub, and optional offline-first sync. The entire library lives in a single file: `src/client.mts`.

The package is ESM-only (`"type": "module"`). The `main` field in `package.json` points directly to `src/client.mts` — there is no compilation or build step. No build, lint, or test scripts are defined.

The file uses TypeScript syntax (type annotations) despite the absence of a `tsconfig.json`.

## Architecture

The library exports three main factory functions and one utility class that follow a plugin composition pattern:

### `createClient(socket, options)`
Core factory. Wraps a socket.io `socket` and returns an `app` object. Communication uses two custom socket events:
- `client-request` / `client-response` — request/response using socket.io acknowledgments to correlate responses to waiting promises
- `service-event` — server-to-client pub/sub notifications
- `app-event` — application-wide broadcast events (outside any service)

`app.configure(callback)` is the standard plugin composition hook — it calls `callback(app)` and is how plugins extend the app.

The `service(name, serviceOptions)` method returns a `Proxy` that intercepts any property access and turns it into a `serviceMethodRequest` call, so callers can write `app.service('user').findMany(...)` without pre-declaring methods. `serviceOptions` supports:
- `timeout` (default 20000 ms) — socket acknowledgment timeout
- `volatile: true` — uses `socket.volatile` (fire-and-forget, drops if disconnected)

### `reloadPlugin(app)`
Enriches `app` with page-reload session continuity. On reconnect it emits `cnx-transfer` carrying the previous socket ID (persisted in `sessionStorage` via `@vueuse/core`'s `useSessionStorage`) so the server can migrate state.

### `offlinePlugin(app)`
Enriches `app` with offline-first IndexedDB CRUD via Dexie. Call `app.createOfflineModel(modelName, fields)` to get a model object.

This plugin also adds three dynamic attributes to `app`:
- `app.isConnected` — boolean, updated on socket connect/disconnect
- `app.connectedDate` — `Date` of the last connection, or `null`
- `app.disconnectedDate` — `Date` of the last disconnection, or `null`

Each model maintains three Dexie stores under the same DB name:
- `values` — the actual records (indexed on `uid`, `__deleted__`)
- `metadata` — per-record `created_at / updated_at / deleted_at`
- `whereList` — set of active `where` filters to scope synchronization

`createOfflineModel` auto-registers pub/sub handlers for the service named `modelName`:
- `createWithMeta` / `updateWithMeta` / `deleteWithMeta` — keep the local cache in sync with server-pushed events

**Optimistic writes**: `create`, `update`, `remove` write to IndexedDB immediately, then call the server service method. On server error they roll back the local change.

**Sync on reconnect**: When the socket reconnects, every registered model calls `synchronizeAll`, which iterates its `whereList` and calls the server's `sync.go(modelName, where, clientMetadataDict)` service. The response contains five buckets (`addClient`, `updateClient`, `deleteClient`, `addDatabase`, `updateDatabase`) that are applied in order.

**Real-time observables**: `getObservable(where)` returns an RxJS `Observable` backed by Dexie's `liveQuery`. It also registers the `where` in `whereList` and triggers a sync if it is a new, unregistered filter. Vue component lifecycle cleanup is handled by `tryOnScopeDispose`.

A shared `Mutex` serializes all sync and `whereList` mutations to avoid concurrent IndexedDB race conditions.

### `where` filter syntax
Used throughout for querying local cache and scoping server sync:
- Equality: `{ field: value }`
- Range: `{ field: { lt, lte, gt, gte } }` — `null`/`undefined` fields never satisfy range clauses (matches SQL NULL semantics)

### Utilities
- `Mutex` — exported; simple async mutex backed by a promise queue
- `wherePredicate(where)` — (module-private) turns a `where` object into a filter function
- `isSubset` / `isSubsetAmong` — (module-private) checks if a `where` is covered by an existing entry in `whereList` (avoids redundant syncs)
- `stringifyWithSortedKeys` — (module-private) deterministic JSON stringify used as canonical `whereList` keys
- `generateUID(length)` — (module-private) alphanumeric random string used to correlate request/response pairs

## Notes
- `uuidv7` is used for client-side record IDs (monotonically increasing, good for B-tree indexes).
- The `prisma/` directory with a SQLite schema is an unrelated artifact and not part of the library.
- All imported packages (`dexie`, `rxjs`, `uuid`, `@vueuse/core`) are consumed by the library but are not listed as `dependencies` — they are expected to be provided by the consuming application.
