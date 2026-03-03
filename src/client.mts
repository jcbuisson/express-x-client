import Dexie from "dexie";
import { from } from 'rxjs';
import { distinctUntilChanged } from 'rxjs/operators';
import { liveQuery } from "dexie";
// uuidv7 are monotonically increasing and much improve database performance amid B-tree indexes
import { v7 as uuidv7 } from 'uuid';
import { tryOnScopeDispose } from '@vueuse/core';
import { useSessionStorage } from '@vueuse/core'


//////////////////////////       EXPRESSX       //////////////////////////

export function createClient(socket, options={}) {
   if (options.debug === undefined) options.debug = false

   const waitingPromisesByUid = {}
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
         func(socket)
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
      connectListeners = connectListeners.filter(f !== func)
   }

   function addDisconnectListener(func) {
      disconnectListeners.push(func)
   }
   function removeDisonnectListener(func) {
      disconnectListeners = disconnectListeners.filter(f !== func)
   }

   function addErrorListener(func) {
      errorListeners.push(func)
   }
   function removeErrorListener(func) {
      errorListeners = errorListeners.filter(f !== func)
   }

   // on receiving response from service request
   socket.on('client-response', ({ uid, error, result }) => {
      if (options.debug) console.log('client-response', uid, error, result)
      if (!waitingPromisesByUid[uid]) return // may not exist because a timeout removed it
      const [resolve, reject] = waitingPromisesByUid[uid]
      if (error) {
         reject(error)
      } else {
         resolve(result)
      }
      delete waitingPromisesByUid[uid]
   })

   // on receiving service events from pub/sub
   socket.on('service-event', ({ name, action, result }) => {
      if (options.debug) console.log('service-event', name, action, result)
      if (!action2service2handlers[action]) action2service2handlers[action] = {}
      const serviceHandlers = action2service2handlers[action]
      const handler = serviceHandlers[name]
      if (handler) handler(result)
   })
   
   async function serviceMethodRequest(name, action, serviceOptions, ...args) {
      // create a promise which will resolve or reject by an event 'client-response'
      const uid = generateUID(20)
      const promise = new Promise((resolve, reject) => {
         waitingPromisesByUid[uid] = [resolve, reject]
         // a timeout may also reject the promise
         if (serviceOptions.timeout && !serviceOptions.volatile) {
            setTimeout(() => {
               delete waitingPromisesByUid[uid]
               reject(`Error: timeout on service '${name}', action '${action}', args: ${JSON.stringify(args)}`)
            }, serviceOptions.timeout)
         }
      })
      // send request to server through websocket
      if (options.debug) console.log('client-request', uid, name, action, args)
      if (serviceOptions.volatile) {
         // event is not sent if connection is not active
         socket.volatile.emit('client-request', { uid, name, action, args, })
      } else {
         // event is buffered if connection is not active (default)
         socket.emit('client-request', { uid, name, action, args, })
      }
      return promise
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

   // There is a need for application-wide events sent outside any service method call, for example when backend state changes
   // without front-end interactions
   socket.on('app-event', ({ type, value }) => {
      if (options.debug) console.log('app-event', type, value)
      if (!type2appHandler[type]) type2appHandler[type] = {}
      const handler = type2appHandler[type]
      if (handler) handler(value)
   })

   // add a handler for application-wide events
   function on(type, handler) {
      type2appHandler[type] = handler
   }

   function connect() {
      if (options.debug) console.log('connecting...')
      socket.connect()
   }

   function disconnect() {
      if (options.debug) console.log('disconnecting...')
      socket.disconnect()
   }

   const app = {
      configure,
      addConnectListener,
      removeConnectListener,
      addDisconnectListener,
      removeDisonnectListener,
      addErrorListener,
      removeErrorListener,
   
      service,
      on,
      connect, disconnect,
   }

   return app
}


//////////////////////////       RELOAD PLUGIN       //////////////////////////
// enrich `app` with listeners handling socket data transfer on page reload

export async function reloadPlugin(app) {

   const cnxid = useSessionStorage('cnxid', '')

   app.addConnectListener(async (socket) => {
      const socketId = socket.id
      console.log('connect', socketId)
      // handle reconnections & reloads
      // look for a previously stored connection id
      const prevSocketId = cnxid.value
      if (prevSocketId) {
         // it's a connection after a reload/refresh
         // ask server to transfer all data from connection `prevSocketId` to connection `socketId`
         console.log('cnx-transfer', prevSocketId, 'to', socketId)
         await socket.emit('cnx-transfer', prevSocketId, socketId)
         // update connection id
         cnxid.value = socketId

      } else {
         // set connection id
         cnxid.value = socketId
      }

      socket.on('cnx-transfer-ack', async (fromSocketId, toSocketId) => {
         console.log('ACK ACK!!!', fromSocketId, toSocketId)
      })

      socket.on('cnx-transfer-error', async (fromSocketId, toSocketId) => {
         console.log('ERR ERR!!!', fromSocketId, toSocketId)
         // appState.value.unrecoverableError = true
      })
   })
}


//////////////////////////       OFFLINE PLUGIN       //////////////////////////
// enrich `app` with methods, attributes and listeners to handle offline-first database access

export function offlinePlugin(app) {

   function createOfflineModel(modelName, fields) {

      const dbName = modelName;
      const db = getOrCreateDB(dbName, fields);

      db.open().then(() => {
         // console.log('db ready', dbName, modelName)
      });

      db.values.hook("updating", (changes, primaryKey, previousValue) => {
         // console.log("CHANGES", primaryKey, changes, previousValue);
      });

      const reset = async () => {
         console.log('reset', modelName);
         await db.whereList.clear();
         await db.values.clear();
         await db.metadata.clear();
      };


      /////////////          PUB / SUB          /////////////

      app.service(modelName).on('createWithMeta', async ([value, meta]) => {
         console.log(`${modelName} EVENT createWithMeta`, value);
         await db.values.put(value);
         await db.metadata.put(meta);
      });

      app.service(modelName).on('updateWithMeta', async ([value, meta]) => {
         console.log(`${modelName} EVENT updateWithMeta`, value);
         await db.values.put(value);
         await db.metadata.put(meta);
      });

      app.service(modelName).on('deleteWithMeta', async ([value, meta]) => {
         console.log(`${modelName} EVENT deleteWithMeta`, value)
         await db.values.delete(value.uid)
         await db.metadata.put(meta)
      });


      /////////////          CREATE/UPDATE/REMOVE          /////////////

      async function create(data) {
         const uid = uuidv7()
         // optimistic update
         const now = new Date()
         await db.values.add({ uid, ...data })
         await db.metadata.add({ uid, created_at: now })
         // execute on server, asynchronously, if connection is active
         if (app.isConnected) {
            app.service(modelName).createWithMeta(uid, data, now)
            .catch(async err => {
               console.log(`*** err sync ${modelName} create`, err)
               // rollback
               await db.values.delete(uid)
            })
         }
         return await db.values.get(uid)
      }

      const update = async (uid: string, data: object) => {
         const previousValue = { ...(await db.values.get(uid)) }
         const previousMetadata = { ...(await db.metadata.get(uid)) }
         // optimistic update of cache
         const now = new Date()
         await db.values.update(uid, data)
         await db.metadata.update(uid, { updated_at: now })
         // execute on server, asynchronously, if connection is active
         if (app.isConnected) {
            app.service(modelName).updateWithMeta(uid, data, now)
            .catch(async err => {
               console.log(`*** err sync ${modelName} update`, err)
               // rollback
               delete previousValue.uid
               await db.values.update(uid, previousValue)
               delete previousMetadata.uid
               await db.metadata.update(uid, previousMetadata)
            })
         }
         return await db.values.get(uid)
      }

      const remove = async (uid: string) => {
         const deleted_at = new Date()
         // optimistic delete in cache
         await db.values.update(uid, { __deleted__: true })
         await db.metadata.update(uid, { deleted_at })
         // and in database, if connected
         if (app.isConnected) {
            app.service(modelName).deleteWithMeta(uid, deleted_at)
            .catch(async err => {
               console.log(`*** err sync ${modelName} remove`, err)
               // rollback
               await db.values.update(uid, { __deleted__: null })
               await db.metadata.update(uid, { deleted_at: null })
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
         addSynchroWhere(where).then((isNew: boolean) => {
            // console.log('getObservable addSynchroWhere', modelName, where, isNew);
            if (isNew && app.isConnected) {
               synchronize(modelName, db.values, db.metadata, where, app.disconnectedDate)
            }
         })
         const predicate = wherePredicate(where)
         return from(liveQuery(() => db.values.filter(value => !value.__deleted__ && predicate(value)).toArray())).pipe(
            distinctUntilChanged((prev, curr) => {
               // Deep equality check to prevent unnecessary emissions (in particular on database write)
               return JSON.stringify(prev) === JSON.stringify(curr)
            })
         )
      }

      let count = 0;
      
      function addSynchroWhere(where: object) {
         const promise = addSynchroDBWhere(where, db.whereList)
         promise.then(isNew => isNew && count++ && console.log(`addSynchroWhere (${count})`, dbName, modelName, where))
         return promise
      }

      function removeSynchroWhere(where: object) {
         console.log('removeSynchroWhere', dbName, modelName, where)
         count -= 1
         return removeSynchroDBWhere(where, db.whereList)
      }

      async function synchronizeAll() {
         await synchronizeModelWhereList(modelName, db.values, db.metadata, app.disconnectedDate, db.whereList)
      }

      // Automatically clean up when the component using this composable unmounts
      tryOnScopeDispose(async () => {
         console.log('CLEANING', dbName, modelName)
         const whereList = await db.whereList.toArray()
         for (const where of whereList) {
            removeSynchroWhere(JSON.parse(where.sortedjson))
         }
      })

      return {
         db, reset,
         create, update, remove,
         findByUID, findWhere,
         getObservable,
         synchronizeAll,
         addSynchroWhere,
      }
   }

   app.addConnectListener(async (_socket) => {
      app.connectedDate = new Date()
      console.log('onConnect', app.connectedDate)
      app.disconnectedDate = null
      app.isConnected = true
   })

   app.addDisconnectListener(async (_socket) => {
      app.connectedDate = null
      app.disconnectedDate = new Date()
      console.log('onDisconnect', app.disconnectedDate)
      app.isConnected = false
   })


   const mutex = new Mutex()

   // ex: where = { uid: 'azer' }
   async function synchronize(modelName, idbValues, idbMetadata, where, cutoffDate) {
      await mutex.acquire()
      console.log('synchronize', modelName, where)

      let toAdd = []
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

         // call sync service on `where` perimeter
         const syncResult = await app.service('sync').go(modelName, where, cutoffDate, clientMetadataDict)
         toAdd = syncResult.toAdd
         const { toUpdate, toDelete, addDatabase, updateDatabase } = syncResult
         console.log('-> service.sync', modelName, where, toAdd, toUpdate, toDelete, addDatabase, updateDatabase)

         // 1- add missing elements in indexedDB cache
         // Use a single transaction for all adds to ensure atomicity
         if (toAdd.length > 0) {
            await idbValues.db.transaction('rw', [idbValues, idbMetadata], async () => {
               for (const [value, metaData] of toAdd) {
                  await idbValues.add(value)
                  await idbMetadata.add(metaData)
               }
            })
         }
         // 2- delete elements from indexedDB cache
         for (const [uid, deleted_at] of toDelete) {
            await idbValues.delete(uid)
            await idbMetadata.update(uid, { deleted_at })
         }
         // 3- update elements of cache
         for (const elt of toUpdate) {
            // get full value of element to update
            const value = await app.service(modelName).findUnique({ where:{ uid: elt.uid }})
            delete value.uid
            delete value.__deleted__
            await idbValues.update(elt.uid, value)
            const metadata = await idbMetadata.get(elt.uid)
            await idbMetadata.update(elt.uid, { updated_at: metadata.updated_at })
         }

         // 4- create elements of `addDatabase` with full data from cache
         for (const elt of addDatabase) {
            const fullValue = await idbValues.get(elt.uid)
            const meta = await idbMetadata.get(elt.uid)
            delete fullValue.uid
            delete fullValue.__deleted__
            try {
               await app.service(modelName).createWithMeta(elt.uid, fullValue, meta.created_at)
            } catch(err) {
               console.log("*** err sync user addDatabase", err, elt.uid, fullValue, meta.created_at)
               // rollback
               await idbValues.delete(elt.uid)
               await idbMetadata.delete(elt.uid)
            }
         }

         // 5- update elements of `updateDatabase` with full data from cache
         for (const elt of updateDatabase) {
            const fullValue = await idbValues.get(elt.uid)
            const meta = await idbMetadata.get(elt.uid)
            delete fullValue.uid
            delete fullValue.__deleted__
            try {
               await app.service(modelName).updateWithMeta(elt.uid, fullValue, meta.updated_at)
            } catch(err) {
               console.log("*** err sync user updateDatabase", err)
               // rollback
               const previousDatabaseValue = await app.service(modelName).findUnique({ where:{ uid: elt.uid }})
               const previousDatabaseMetadata = await app.service('metadata').findUnique({ where:{ uid: elt.uid }})
               await idbValues.update(elt.uid, previousDatabaseValue)
               await idbMetadata.update(elt.uid, previousDatabaseMetadata)
            }
         }
      } catch(err) {
         console.log('err synchronize', modelName, where, err)
      } finally {
         mutex.release()
      }
   }

   function wherePredicate(where) {
      return (elt) => {
         for (const [attr, value] of Object.entries(where)) {
            const eltAttrValue = elt[attr]

            if (typeof(value) === 'string' || typeof(value) === 'number') {
               // 'attr = value' clause
               if (eltAttrValue !== value) return false

            } else if (typeof(value) === 'object') {
               // 'attr = { lt/lte/gt/gte: value }' clause
               if (value.lte) {
                  if (eltAttrValue > value.lte) return false
               } else if (value.lt) {
                  if (eltAttrValue >= value.lt) return false
               } else if (value.gte) {
                  if (eltAttrValue < value.gte) return false
               } else if (value.gt) {
                  if (eltAttrValue <= value.gt) return false
               }
            }
         }
         return true
      }
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

   async function synchronizeModelWhereList(modelName, idbValues, idbMetadata, cutoffDate, whereDb) {
      const whereList = await getWhereList(whereDb)
      for (const where of whereList) {
         await synchronize(modelName, idbValues, idbMetadata, where, cutoffDate)
      }
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

   // enrich `app` with new methods and attributes
   return Object.assign(app, {
      createOfflineModel,
   })
}


//////////////////////////       UTILITIES       //////////////////////////

function generateUID(length) {
   const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
   let uid = ''

   for (let i = 0; i < length; i++) {
     const randomIndex = Math.floor(Math.random() * characters.length)
     uid += characters.charAt(randomIndex)
   }
   return uid
}


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

function isSubset(subset, fullObject) {
   // return Object.entries(subset).some(([key, value]) => fullObject[key] === value)
   for (const key in fullObject) {
      if (fullObject[key] !== subset[key]) return false
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

