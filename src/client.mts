import Dexie from "dexie";
import { from, defer } from 'rxjs';
import { distinctUntilChanged, startWith, switchMap } from 'rxjs/operators';
import { liveQuery } from "dexie";
// uuidv7 are monotonically increasing and much improve database performance amid B-tree indexes
import { v7 as uuidv7 } from 'uuid';
import { tryOnScopeDispose } from '@vueuse/core';
import { useSessionStorage } from '@vueuse/core'


//////////////////////////       EXPRESSX       //////////////////////////

export function createClient(socket, options={}) {
   if (options.debug === undefined) options.debug = false

   const action2service2handlers = {}
   const type2appHandler = {}
   let connectListeners = []
   let disconnectListeners = []
   let errorListeners = []

   function configure(callback, ...args) {
      callback(app, ...args)
   }

   socket.on("connect", async () => {
      if (options.debug) console.log("socket connected", socket.id)
      for (const func of connectListeners) {
         try {
            await func(socket)
         } catch(err) {
            console.error('connect listener error', err)
         }
      }
   })

   socket.on("connect_error", async (err) => {
      if (options.debug) console.log("socket connection error", socket.id)
      for (const func of errorListeners) {
         func(socket)
      }
   })

   socket.on("disconnect", async () => {
      if (options.debug) console.log("socket disconnected", socket.id)
      for (const func of disconnectListeners) {
         func(socket)
      }
   })

   function addConnectListener(func) {
      connectListeners.push(func)
   }
   function removeConnectListener(func) {
      connectListeners = connectListeners.filter(f => f !== func)
   }

   function addDisconnectListener(func) {
      disconnectListeners.push(func)
   }
   function removeDisconnectListener(func) {
      disconnectListeners = disconnectListeners.filter(f => f !== func)
   }

   function addErrorListener(func) {
      errorListeners.push(func)
   }
   function removeErrorListener(func) {
      errorListeners = errorListeners.filter(f => f !== func)
   }

   // on receiving service events from pub/sub
   socket.on('service-event', ({ name, action, result }) => {
      if (options.debug) console.log('service-event', name, action, result)
      if (!action2service2handlers[action]) action2service2handlers[action] = {}
      const serviceHandlers = action2service2handlers[action]
      const handler = serviceHandlers[name]
      if (handler) Promise.resolve(handler(result)).catch(err => console.error('service-event handler error', name, action, err))
   })
   
   async function serviceMethodRequest(name, action, serviceOptions, ...args) {
      if (options.debug) console.log('client-request', name, action, args)
      // use socket.io acknowledgment for request/response correlation
      const emitter = serviceOptions.volatile
         ? socket.volatile
         : socket.timeout(serviceOptions.timeout || 20000)
      const { error, result } = await emitter.emitWithAck('client-request', { name, action, args })
      if (error) throw error
      return result
   }

   function service(name, serviceOptions={}) {
      if (serviceOptions.timeout === undefined) serviceOptions.timeout = 20000
      const service = {
         // associate a handler to a pub/sub event for this service
         on: (action, handler) => {
            if (!action2service2handlers[action]) action2service2handlers[action] = {}
            const serviceHandlers = action2service2handlers[action]
            serviceHandlers[name] = handler
         },
      }
      // use a Proxy to allow for any method name for a service
      const handler = {
         get(service, action) {
            if (!(action in service)) {
               // newly used property `action`: define it as a service method request function
               service[action] = (...args) => serviceMethodRequest(name, action, serviceOptions, ...args)
            }
            return service[action]
         }
      }
      return new Proxy(service, handler)
   }

   //--------------------         APPLICATION-LEVEL EVENTS         --------------------

   // There is a need for application-wide events sent outside any service method call, for example when backend state changes
   // without front-end interactions
   socket.on('app-event', ({ type, value }) => {
      if (options.debug) console.log('app-event', type, value)
      const handler = type2appHandler[type]
      if (typeof handler === 'function') handler(value)
   })

   // add a handler for application-wide events
   function on(type, handler) {
      type2appHandler[type] = handler
   }

   const app = {
      configure,
      addConnectListener,
      removeConnectListener,
      addDisconnectListener,
      removeDisconnectListener,
      addErrorListener,
      removeErrorListener,
   
      service,
      on,
   }

   return app
}


//////////////////////////       RELOAD PLUGIN       //////////////////////////
// Enrich `app` with listeners handling socket data transfer on page reload

export async function reloadPlugin(app) {

   const cnxid = useSessionStorage('cnxid', '')

   app.addConnectListener(async (socket) => {
      const socketId = socket.id
      console.log('connect', socketId)
      const prevSocketId = cnxid.value
      if (prevSocketId) {
         console.log('cnx-transfer', prevSocketId, 'to', socketId)
         socket.once('cnx-transfer-ack', async (fromSocketId, toSocketId) => {
            console.log('ACK ACK!!!', fromSocketId, toSocketId)
            cnxid.value = socketId
         })
         socket.once('cnx-transfer-error', async (fromSocketId, toSocketId) => {
            console.log('ERR ERR!!!', fromSocketId, toSocketId)
            cnxid.value = socketId
         })
         socket.emit('cnx-transfer', prevSocketId, socketId)
      } else {
         cnxid.value = socketId
      }
   })
}


//////////////////////////       OFFLINE PLUGIN       //////////////////////////
// Enrich `app` with methods, attributes and listeners to handle offline-first crud database access

export function offlinePlugin(app) {

   const modelSyncFunctions = []

   function createOfflineModel(modelName, fields) {

      const dbName = modelName;
      const db = getOrCreateDB(dbName, fields);
      const synchronizedWhereKeys = new Set();
      const synchronizeWherePromises = new Map();

      const reset = async () => {
         console.log('reset', modelName);
         await db.whereList.clear();
         await db.values.clear();
         await db.metadata.clear();
      };


      /////////////          PUB / SUB          /////////////

      app.service(modelName).on('createWithMeta', async ([value, meta]) => {
         console.log(`${modelName} EVENT createWithMeta`, value);
         if (await isIncomingEventStale(value?.uid ?? meta?.uid, meta)) return
         if (!value?.uid && meta?.deleted_at) {
            await db.values.delete(meta.uid)
            await db.metadata.delete(meta.uid)
            return
         }
         if (value?.uid) await db.values.put(value);
         if (meta?.uid) await db.metadata.put({ ...meta, __dirty__: false });
      });

      app.service(modelName).on('updateWithMeta', async ([value, meta]) => {
         console.log(`${modelName} EVENT updateWithMeta`, value);
         // value may be undefined when the server's update yielded 0 rows
         // (concurrent delete race: record was removed between the sync's findMany
         // snapshot and the actual update). Guard to avoid a TypeError crash that
         // would prevent db.metadata.put(meta) from running.
         if (await isIncomingEventStale(value?.uid ?? meta?.uid, meta)) return
         if (!value?.uid && meta?.deleted_at) {
            await db.values.delete(meta.uid)
            await db.metadata.delete(meta.uid)
            return
         }
         if (value?.uid) await db.values.put(value);
         if (meta?.uid) await db.metadata.put({ ...meta, __dirty__: false });
      });

      app.service(modelName).on('deleteWithMeta', async ([value, meta]) => {
         console.log(`${modelName} EVENT deleteWithMeta`, value)
         // value may be undefined when the server's delete yielded 0 rows
         // (double-delete race).
         // delete, not put: synchronize() step 2 also deletes idbMetadata for the same
         // uid. If the pub/sub handler fires AFTER step 2, put() would re-create the
         // metadata row as a permanent orphan. delete() is idempotent regardless of order.
         const uid = value?.uid ?? meta?.uid
         if (await isIncomingEventStale(uid, meta)) return
         if (value?.uid) await db.values.delete(value.uid)
         if (uid) await db.metadata.delete(uid)
      });

      async function isIncomingEventStale(uid, incomingMeta) {
         if (!uid || !incomingMeta) return false
         const currentMeta = await db.metadata.get(uid)
         if (!currentMeta) return false
         return compareMetadataTime(currentMeta, incomingMeta) > 0
      }


      /////////////          CREATE/UPDATE/REMOVE          /////////////

      async function create(data) {
         // in offline-first context, uid is created client-side, since server may not be accessible
         const uid = uuidv7()
         // optimistic update
         const now = new Date()
         await db.values.add({ uid, ...data })
         await db.metadata.add({ uid, created_at: now, __dirty__: true })
         // execute on server, asynchronously, if connection is active
         if (app.isConnected) {
            app.service(modelName).createWithMeta(uid, data, now)
            .then(result => applyCreateAcknowledgement(uid, now, result))
            .catch(async err => {
               console.log(`*** err sync ${modelName} create`, err)
               const currentMetadata = await db.metadata.get(uid)
               if (!isCreateRequestStillCurrent(currentMetadata, now)) return
               // rollback
               await db.values.delete(uid)
               await db.metadata.delete(uid)
            })
         }
         return await db.values.get(uid)
      }

      async function applyCreateAcknowledgement(uid, requestCreatedAt, result) {
         const currentMetadata = await db.metadata.get(uid)
         if (!isCreateRequestStillCurrent(currentMetadata, requestCreatedAt)) return
         const [value, meta] = Array.isArray(result) ? result : []
         if (!value?.uid && meta?.deleted_at) {
            await db.values.delete(uid)
            await db.metadata.delete(uid)
            return
         }
         if (value?.uid) await db.values.put(value)
         if (meta?.uid)
            await db.metadata.put({ ...meta, __dirty__: false })
         else
            await db.metadata.update(uid, { __dirty__: false })
      }

      function isCreateRequestStillCurrent(currentMetadata, requestCreatedAt) {
         return currentMetadata
            && sameTimestamp(currentMetadata.created_at, requestCreatedAt)
            && !currentMetadata.updated_at
            && !currentMetadata.deleted_at
      }

      async function applyUpdateAcknowledgement(uid, requestUpdatedAt, result) {
         const currentMetadata = await db.metadata.get(uid)
         if (!currentMetadata || !sameTimestamp(currentMetadata.updated_at, requestUpdatedAt)) return
         const [value, meta] = Array.isArray(result) ? result : []
         if (!value?.uid && meta?.deleted_at) {
            await db.values.delete(uid)
            await db.metadata.delete(uid)
            return
         }
         if (value?.uid) await db.values.put(value)
         if (meta?.uid)
            await db.metadata.put({ ...meta, __dirty__: false })
         else
            await db.metadata.update(uid, { __dirty__: false })
      }

      async function applyDeleteAcknowledgement(uid, requestDeletedAt, result) {
         const currentMetadata = await db.metadata.get(uid)
         if (!currentMetadata || !sameTimestamp(currentMetadata.deleted_at, requestDeletedAt)) return
         const [value, meta] = Array.isArray(result) ? result : []
         if (value?.uid && !meta?.deleted_at) {
            const restoredValue = { ...value }
            delete restoredValue.__deleted__
            await db.values.put(restoredValue)
         }
         if (meta?.uid)
            await db.metadata.put({ ...meta, __dirty__: false })
         else
            await db.metadata.update(uid, { __dirty__: false })
      }

      const update = async (uid: string, data: object) => {
         const previousValue = { ...(await db.values.get(uid)) }
         const previousMetadata = { ...(await db.metadata.get(uid)) }
         // optimistic update of cache
         const now = new Date()
         await db.values.update(uid, data)
         await db.metadata.update(uid, { updated_at: now, __dirty__: true })
         // execute on server, asynchronously, if connection is active
         if (app.isConnected) {
            app.service(modelName).updateWithMeta(uid, data, now)
            .then(result => applyUpdateAcknowledgement(uid, now, result))
            .catch(async err => {
               console.log(`*** err sync ${modelName} update`, err)
               const currentMetadata = await db.metadata.get(uid)
               if (!currentMetadata || !sameTimestamp(currentMetadata.updated_at, now)) return
               // rollback
               delete previousValue.uid
               await db.values.update(uid, previousValue)
               // Only restore updated_at — the optimistic write only touched that field.
               // Restoring the full previousMetadata snapshot would overwrite any
               // deleted_at that remove() set while the socket round-trip was in flight,
               // silently un-deleting the record.
               await db.metadata.update(uid, {
                  updated_at: previousMetadata.updated_at ?? null,
                  __dirty__: previousMetadata.__dirty__ ?? false,
               })
            })
         }
         return await db.values.get(uid)
      }

      const remove = async (uid: string) => {
         const deleted_at = new Date()
         // optimistic delete in cache
         await db.values.update(uid, { __deleted__: true })
         await db.metadata.update(uid, { deleted_at, __dirty__: true })
         // and in database, if connected
         if (app.isConnected) {
            app.service(modelName).deleteWithMeta(uid, deleted_at)
            .then(result => applyDeleteAcknowledgement(uid, deleted_at, result))
            .catch(async err => {
               console.log(`*** err sync ${modelName} remove`, err)
               const currentMetadata = await db.metadata.get(uid)
               if (!currentMetadata || !sameTimestamp(currentMetadata.deleted_at, deleted_at)) return
               // rollback
               await db.values.update(uid, { __deleted__: null })
               await db.metadata.update(uid, { deleted_at: null, __dirty__: false })
            })
         }
      }

      /////////////          DIRECT CACHE ACCESS          /////////////

      function findByUID(uid) {
         return db.values.get(uid)
      }

      function findWhere(where = {}) {
         const predicate = wherePredicate(where)
         return db.values.filter(value => !value.__deleted__ && predicate(value)).toArray()
      }

      /////////////          REAL-TIME OBSERVABLE          /////////////

      function getObservable(where = {}) {
         const predicate = wherePredicate(where)
         const liveQuery$ = from(liveQuery(() => db.values.filter(value => !value.__deleted__ && predicate(value)).toArray())).pipe(
            distinctUntilChanged((prev, curr) => {
               // Deep equality check to prevent unnecessary emissions (in particular on database write)
               return JSON.stringify(prev) === JSON.stringify(curr)
            })
         )
         
         // Delay subscribing to liveQuery until the cache is up to date: if `where` is a
         // newly-registered filter and we're online, wait for synchronize() to complete
         // first, so the first emission is already the fully synced data (or [] if truly
         // empty). Otherwise (warm cache or offline) there's nothing to wait for.
         //
         // defer() gates the liveQuery subscription:
         //   - defer re-runs the setup on each subscription, calling addSynchroWhere(where) to get isNew.
         //   - If isNew && app.isConnected, it chains synchronize(...) before switching to liveQuery$, so the first emission already reflects
         //   the fully-synced cache ([] only if genuinely empty).
         //   - If !isNew or offline, the .then resolves to undefined immediately and switchMap subscribes to liveQuery$ right away — same
         //   behavior as before.
         return defer(() => {
            const ready = addSynchroWhere(where).then((isNew: boolean) => {
               const whereKey = stringifyWithSortedKeys(where)
               if (app.isConnected && (isNew || !synchronizedWhereKeys.has(whereKey))) {
                  return synchronizeWhere(where)
               }
            })
            return from(ready).pipe(switchMap(() => liveQuery$))
         })
      }

      let count = 0;
      
      function addSynchroWhere(where: object) {
         const promise = addSynchroDBWhere(where, db.whereList)
         promise.then(isNew => isNew && console.log(`addSynchroWhere (${++count})`, dbName, modelName, where))
         return promise
      }

      function removeSynchroWhere(where: object) {
         console.log('removeSynchroWhere', dbName, modelName, where)
         count -= 1
         synchronizedWhereKeys.delete(stringifyWithSortedKeys(where))
         return removeSynchroDBWhere(where, db.whereList)
      }

      async function synchronizeAll() {
         await synchronizeModelWhereList(modelName, db.values, db.metadata, db.whereList, synchronizeWhere)
      }

      async function synchronizeWhere(where) {
         const whereKey = stringifyWithSortedKeys(where)
         if (!synchronizeWherePromises.has(whereKey)) {
            const promise = synchronize(modelName, db.values, db.metadata, where)
               .then(() => {
                  synchronizedWhereKeys.add(whereKey)
               })
               .finally(() => {
                  synchronizeWherePromises.delete(whereKey)
               })
            synchronizeWherePromises.set(whereKey, promise)
         }
         return synchronizeWherePromises.get(whereKey)
      }

      // Automatically clean up when the component using this composable unmounts
      tryOnScopeDispose(async () => {
         console.log('CLEANING', dbName, modelName)
         const whereList = await db.whereList.toArray()
         for (const where of whereList) {
            removeSynchroWhere(JSON.parse(where.sortedjson))
         }
      })

      modelSyncFunctions.push(synchronizeAll)

      return {
         db, reset,
         create, update, remove,
         findByUID, findWhere,
         getObservable,
         synchronizeAll,
         addSynchroWhere,
      }
   }

   let hasConnected = false

   app.addConnectListener(async (_socket) => {
      app.connectedDate = new Date()
      console.log('onConnect', app.connectedDate)
      app.isConnected = true
      const disconnectedDate = app.disconnectedDate
      const isInitialConnect = !hasConnected
      hasConnected = true
      if (disconnectedDate || isInitialConnect) {
         const results = await Promise.allSettled(modelSyncFunctions.map(sync => sync()))
         const failures = results.filter(result => result.status === 'rejected')
         if (failures.length > 0) {
            console.error('err reconnect synchronizeAll', failures.map(result => result.reason))
            return
         }
      }
      app.disconnectedDate = null
   })

   app.addDisconnectListener(async (_socket) => {
      app.connectedDate = null
      app.disconnectedDate = new Date()
      console.log('onDisconnect', app.disconnectedDate)
      app.isConnected = false
   })


   const mutex = new Mutex()

   // ex: where = { uid: 'azer' }
   async function synchronize(modelName, idbValues, idbMetadata, where) {
      await mutex.acquire()
      console.log('synchronize', modelName, where)

      try {
         const requestPredicate = wherePredicate(where)

         // collect meta-data of local values
         // NOTE: __delete__ on values allows to collect metadata from cache-deleted values
         const valueList = await idbValues.filter(requestPredicate).toArray()
         const clientMetadataDict = {}
         for (const value of valueList) {
            const metadata = await idbMetadata.get(value.uid)
            if (metadata) {
               clientMetadataDict[value.uid] = metadata
            } else {
               // should not happen
               clientMetadataDict[value.uid] = {}
            }
         }
         const dirtyMetadataList = await idbMetadata.filter(metadata => metadata.__dirty__).toArray()
         for (const metadata of dirtyMetadataList) {
            if (metadata.uid in clientMetadataDict) continue
            const value = await idbValues.get(metadata.uid)
            if (value || metadata.deleted_at) clientMetadataDict[metadata.uid] = metadata
         }

         // call sync service on `where` perimeter
         const { addClient, updateClient, deleteClient, addDatabase, updateDatabase } =
            await app.service('sync').go(modelName, where, clientMetadataDict)
         console.log('-> service.sync', modelName, where, addClient, updateClient, deleteClient, addDatabase, updateDatabase)

         // 1- add missing elements in indexedDB cache
         // Use a single transaction for all adds to ensure atomicity.
         // put() instead of add() for metadata: a deleteWithMeta pub/sub event leaves
         // an orphaned metadata row (value deleted, metadata kept with deleted_at).
         // add() would throw a ConstraintError on that orphan; put() upserts safely.
         if (addClient.length > 0) {
            await idbValues.db.transaction('rw', [idbValues, idbMetadata], async () => {
               for (const [value, metaData] of addClient) {
                  // put() instead of add(): if create() ran concurrently and added this
                  // uid to Dexie between the idbValues.filter snapshot and this step,
                  // add() would throw ConstraintError and abort the entire transaction,
                  // silently dropping every other addClient record in the batch.
                  const currentMetadata = await idbMetadata.get(value.uid)
                  if (currentMetadata && compareMetadataTime(metaData, currentMetadata) <= 0) continue
                  await idbValues.put(value)
                  await idbMetadata.put({ ...metaData, __dirty__: false })
               }
            })
         }
         // 2- delete elements from indexedDB cache
         if (deleteClient.length > 0) {
            await idbValues.db.transaction('rw', [idbValues, idbMetadata], async () => {
               for (const [uid] of deleteClient) {
                  const currentMetadata = await idbMetadata.get(uid)
                  if (!metadataUnchangedSinceRequest(currentMetadata, clientMetadataDict[uid])) continue
                  await idbValues.delete(uid)
                  await idbMetadata.delete(uid)
               }
            })
         }
         // 3- update elements of cache with server's newer version
         for (const [elt, serverMeta] of updateClient) {
            const currentMetadata = await idbMetadata.get(elt.uid)
            if (!metadataUnchangedSinceRequest(currentMetadata, clientMetadataDict[elt.uid])) continue
            const value = { ...elt }
            delete value.__deleted__
            await idbValues.put(value)
            await idbMetadata.put({ uid: elt.uid, ...serverMeta, __dirty__: false })
         }

         // 4- create elements of `addDatabase` with full data from cache
         for (const elt of addDatabase) {
            // elt.uid is undefined when the clientMetadataDict fallback {} was used
            // (record exists in idbValues but metadata is missing).  Guard before the
            // get() call: idbValues.get(undefined) itself throws before fullValue is
            // assigned, so checking fullValue == null afterwards is too late.
            if (elt.uid == null) continue
            let currentMetadata = await idbMetadata.get(elt.uid)
            if (!metadataUnchangedSinceRequest(currentMetadata, elt)) continue
            const fullValue = await idbValues.get(elt.uid)
            if (fullValue == null) continue  // record deleted concurrently
            delete fullValue.uid
            delete fullValue.__deleted__
            try {
               const result = await app.service(modelName).createWithMeta(elt.uid, fullValue, elt.created_at)
               const serverMeta = Array.isArray(result) ? result[1] : null
               currentMetadata = await idbMetadata.get(elt.uid)
               if (!metadataUnchangedSinceRequest(currentMetadata, elt)) continue
               if (Array.isArray(result) && !result[0]?.uid && serverMeta?.deleted_at) {
                  await idbValues.delete(elt.uid)
                  await idbMetadata.delete(elt.uid)
                  continue
               }
               if (serverMeta?.uid) await idbMetadata.put({ ...serverMeta, __dirty__: false })
               else await idbMetadata.update(elt.uid, { __dirty__: false })
            } catch(err) {
               console.log("*** err sync user addDatabase", err, elt.uid, fullValue, elt.created_at)
               currentMetadata = await idbMetadata.get(elt.uid)
               if (!metadataUnchangedSinceRequest(currentMetadata, elt)) continue
               // rollback
               await idbValues.delete(elt.uid)
               await idbMetadata.delete(elt.uid)
            }
         }

         // 5- update elements of `updateDatabase` with full data from cache
         for (const elt of updateDatabase) {
            if (elt.uid == null) continue
            let currentMetadata = await idbMetadata.get(elt.uid)
            if (!metadataUnchangedSinceRequest(currentMetadata, elt)) continue
            const fullValue = await idbValues.get(elt.uid)
            if (fullValue == null) continue  // record deleted concurrently
            delete fullValue.uid
            delete fullValue.__deleted__
            try {
               const result = await app.service(modelName).updateWithMeta(elt.uid, fullValue, elt.updated_at)
               const serverMeta = Array.isArray(result) ? result[1] : null
               currentMetadata = await idbMetadata.get(elt.uid)
               if (!metadataUnchangedSinceRequest(currentMetadata, elt)) continue
               if (Array.isArray(result) && !result[0]?.uid && serverMeta?.deleted_at) {
                  await idbValues.delete(elt.uid)
                  await idbMetadata.delete(elt.uid)
                  continue
               }
               if (serverMeta?.uid) await idbMetadata.put({ ...serverMeta, __dirty__: false })
               else await idbMetadata.update(elt.uid, { __dirty__: false })
            } catch(err) {
               console.log("*** err sync user updateDatabase", err)
               // Leave client's local version intact; it will be retried on the next sync.
            }
         }
      } catch(err) {
         console.log('err synchronize', modelName, where, err)
         throw err
      } finally {
         mutex.release()
      }
   }

   function metadataUnchangedSinceRequest(currentMetadata, requestMetadata) {
      return currentMetadata
         && requestMetadata
         && sameTimestamp(currentMetadata.created_at, requestMetadata.created_at)
         && sameTimestamp(currentMetadata.updated_at, requestMetadata.updated_at)
         && sameTimestamp(currentMetadata.deleted_at, requestMetadata.deleted_at)
   }

   // Singleton map to reuse Dexie instances per database name
   const dbInstances = new Map();

   function getOrCreateDB(dbName: string, fields: string[]) {
      if (!dbInstances.has(dbName)) {
         const db = new Dexie(dbName);
         db.version(1).stores({
            whereList: "sortedjson",
            values: ['uid', '__deleted__', ...fields].join(','),
            metadata: "uid, created_at, updated_at, deleted_at",
         });
         dbInstances.set(dbName, db);
      }
      return dbInstances.get(dbName);
   }

   async function getWhereList(whereDb) {
      const list = await whereDb.toArray()
      return list.map(elt => JSON.parse(elt.sortedjson))
   }

   async function addSynchroDBWhere(where, whereDb) {
      await mutex.acquire()
      let modified = false
      try {
         const whereList = await getWhereList(whereDb)
         if (!isSubsetAmong(where, whereList)) {
            // sortedjson is used as a unique standardized representation of a 'where' object ; it is used both as key and value in 'wheredb' database
            await whereDb.add({ sortedjson: stringifyWithSortedKeys(where) })
            modified = true
         }
      } catch(err) {
         console.log('err addSynchroDBWhere', where, err)
      } finally {
         mutex.release()
      }
      return modified
   }

   async function removeSynchroDBWhere(where, whereDb) {
      await mutex.acquire()
      try {
         const swhere = stringifyWithSortedKeys(where)
         await whereDb.filter(value => (value.sortedjson === swhere)).delete()
      } catch(err) {
         console.log('err removeSynchroDBWhere', err)
      } finally {
         mutex.release()
      }
   }

   async function synchronizeModelWhereList(modelName, idbValues, idbMetadata, whereDb, syncWhere = null) {
      const whereList = await getWhereList(whereDb)
      for (const where of whereList) {
         if (syncWhere) await syncWhere(where)
         else await synchronize(modelName, idbValues, idbMetadata, where)
      }
   }

   // enrich `app` with new methods and attributes
   return Object.assign(app, {
      createOfflineModel,
   })
}


//////////////////////////       UTILITIES       //////////////////////////


function stringifyWithSortedKeys(obj, space = null) {
   return JSON.stringify(obj, (key, value) => {
      // If the value is a plain object (not an array, null, or other object type like Date)
      if (value && typeof value === 'object' && !Array.isArray(value) && Object.prototype.toString.call(value) === '[object Object]') {
         const sorted = {};
         // Get all keys, sort them, and then re-add them to a new object
         // This new object will maintain the sorted order when stringified
         Object.keys(value).sort().forEach(k => {
            sorted[k] = value[k];
         });
         return sorted;
      }
      // For all other types (primitives, arrays, null, etc.), return the value as is
      return value;
   }, space); // 'space' is optional for pretty-printing (e.g., 2 or 4)
}
// console.log('stringifyWithSortedKeys({ age: 30, name: "Alice", data: { city: "Paris", color: "red" }})', stringifyWithSortedKeys({ age: 30, name: "Alice", data: { city: "Paris", color: "red" } }))

function sameTimestamp(a, b) {
   if (!a || !b) return a === b
   return new Date(a).getTime() === new Date(b).getTime()
}

function compareMetadataTime(a, b) {
   const aTime = metadataTime(a)
   const bTime = metadataTime(b)
   if (aTime == null || bTime == null) return 0
   return aTime - bTime
}

function metadataTime(meta) {
   const value = meta?.deleted_at ?? meta?.updated_at ?? meta?.created_at
   if (!value) return null
   const time = new Date(value).getTime()
   return Number.isNaN(time) ? null : time
}

export class Mutex {
   constructor() {
      this.locked = false;
      this.queue = [];
   }

   async acquire() {
      if (this.locked) {
         return new Promise(resolve => this.queue.push(resolve));
      }
      this.locked = true;
   }

   release() {
      if (this.queue.length > 0) {
         const next = this.queue.shift();
         next();
      } else {
         this.locked = false;
      }
   }
}

function wherePredicate(where) {
   return (elt) => {
      for (const [attr, value] of Object.entries(where)) {
         const eltAttrValue = elt[attr]

         if (typeof(value) === 'string' || typeof(value) === 'number' || typeof(value) === 'boolean') {
            // 'attr = value' clause
            if (eltAttrValue !== value) return false

         } else if (value === null) {
            // 'attr = null' clause
            if (eltAttrValue !== null) return false

         } else if (typeof(value) === 'object') {
            // 'attr = { lt/lte/gt/gte: value }' clause — all bounds apply.
            // A missing (undefined) or null field never satisfies a range constraint,
            // consistent with SQL NULL behaviour (NULL op anything = NULL = unknown).
            // JS coerces null → 0 so range guards like `null > 10` silently pass;
            // undefined coerces to NaN and all NaN comparisons return false — both
            // must be excluded explicitly.
            if (eltAttrValue === undefined || eltAttrValue === null) return false
            if ('lte' in value && eltAttrValue > value.lte) return false
            if ('lt'  in value && eltAttrValue >= value.lt)  return false
            if ('gte' in value && eltAttrValue < value.gte)  return false
            if ('gt'  in value && eltAttrValue <= value.gt)  return false
         }
      }
      return true
   }
}

function isSubset(subset, fullObject) {
   for (const key in fullObject) {
      const fVal = fullObject[key]
      const sVal = subset[key]
      // Primitive values: use reference/value equality (works for string, number, boolean).
      // Object values (e.g. range operators { gte: 1 }): use structural equality via
      // sorted JSON so that two freshly-created identical objects compare as equal.
      if (typeof fVal === 'object' && fVal !== null) {
         if (stringifyWithSortedKeys(fVal) !== stringifyWithSortedKeys(sVal)) return false
      } else {
         if (fVal !== sVal) return false
      }
   }
   return true
}
// console.log('isSubset({a: 1, b: 2}, {b: 2})=true', isSubset({a: 1, b: 2}, {b: 2}))
// console.log('isSubset({}, {})=true', isSubset({}, {}))
// console.log('isSubset({a: 1}, {})=true', isSubset({a: 1}, {}))
// console.log('isSubset({a: 1}, {b: 2})=false', isSubset({a: 1}, {b: 2}))
// console.log('isSubset({a: 1}, {a: 1})=true', isSubset({a: 1}, {a: 1}))

function isSubsetAmong(subset, fullObjectList) {
   return fullObjectList.some(fullObject => isSubset(subset, fullObject));
}
// console.log('isSubsetAmong({a: 1, b: 2}, [{c: 3}, {b: 2}])=true', isSubsetAmong({a: 1, b: 2}, [{c: 3}, {b: 2}]))
