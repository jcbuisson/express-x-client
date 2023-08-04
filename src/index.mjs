 
export default function expressXClient(socket, options={}) {
   if (options.debug === undefined) options.debug = false
   if (options.timeout === undefined) options.timeout = 5000

   const waitingPromisesByUid = {}
   const action2service2handlers = {}
   const type2appHandlers = {}
   let onConnectionCallback = null
   let onDisconnectionCallback = null
   let nodeCnxId

   const setConnectionCallback = (callback) => {
      onConnectionCallback = callback
   }

   const setDisconnectionCallback = (callback) => {
      onDisconnectionCallback = callback
   }

   function _getCnxId() {
      if (typeof sessionStorage !== 'undefined') return sessionStorage.getItem('expressx-cnx-id')
      return nodeCnxId
   }

   function _setCnxId(id) {
      if (typeof sessionStorage !== 'undefined') {
         sessionStorage.setItem('expressx-cnx-id', id)
      } else {
         nodeCnxId = id
      }
   }

   // on connection
   socket.on("connected", async (connectionId) => {
      if (options.debug) console.log('connected', connectionId)
      // look for a previously stored connection id
      const prevConnectionId = _getCnxId()
      if (prevConnectionId) {
         // it's a reconnection
         if (prevConnectionId < 0) {
            // ask server to transfer all data from connection `prevConnectionId` to connection `connectionId`
            if (options.debug) console.log('cnx-transfer', -prevConnectionId, 'to', connectionId)
            socket.emit('cnx-transfer', {
               from: -prevConnectionId,
               to: connectionId,
            })
            // set/update connection id
            _setCnxId(connectionId)
         } else {
            if (options.debug) console.log('Error, previous connection id should be negative', prevConnectionId)
         }

      } else {
         // set/update connection id
         _setCnxId(connectionId)
      }
      // call user-defined connection callback
      if (onConnectionCallback) onConnectionCallback(connectionId)
   })

   socket.on("cnx-transfer-ack", async (connectionId) => {
      if (options.debug) console.log('cnx-transfer-ack', connectionId)
      _setCnxId(connectionId)
   })


   // A negative value for the connexion id means that the connection with the server has been lost
   // Requests must wait until it goes positive again

   // disconnection due to network issues
   socket.on("disconnect", async (cause) => {
      const id = _getCnxId()
      if (id > 0) {
         _setCnxId(-id)
      } else {
         if (options.debug) console.log('Error (disconnect), connection id should be negative', id)
      }
   })

   // disconnection due to a page reload
   if (typeof window !== 'undefined' && 'addEventListener' in window) {
      window.addEventListener('unload', () => {
         const id = _getCnxId()
         if (id > 0) {
            _setCnxId(-id)
         } else {
            if (options.debug) console.log('Error (unload), connection id should be negative', id)
         }
      })
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

   // on receiving application events from pub/sub
   socket.on('app-event', ({ type, value }) => {
      if (options.debug) console.log('app-event', type, value)
      if (!type2appHandlers[type]) type2appHandlers[type] = {}
      const handler = type2appHandlers[type]
      if (handler) handler(value)
   })

   function wait(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
   }

   async function serviceMethodRequest(name, action, ...args) {
      // wait while stored connexion id is negative (= connection is lost with server)
      let retries = 10
      while (retries-- > 0) {
         const id = _getCnxId()
         if (id > 0) break
         await wait(200)
      }
      if (retries === 0) throw new Error(`Timeout waiting for reconnection`)

      // create a promise which will resolve or reject by an event 'client-response'
      const uid = generateUID(20)
      const promise = new Promise((resolve, reject) => {
         waitingPromisesByUid[uid] = [resolve, reject]
         // a timeout may also reject the promise
         setTimeout(() => {
            delete waitingPromisesByUid[uid]
            reject(`Error: timeout on service '${name}', action '${action}', args: ${JSON.stringify(args)}`)
         }, options.timeout)
      })
      // send request to server through websocket
      if (options.debug) console.log('client-request', uid, name, action, args)
      socket.emit('client-request', {
         uid,
         name,
         action,
         args,
      })
      return promise
   }

   // define application events handlers
   function on(type, handler) {
      if (!type2appHandlers[type]) type2appHandlers[type] = {}
      type2appHandlers[type] = handler
   }

   function service(name) {
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
               service[action] = (...args) => serviceMethodRequest(name, action, ...args)
            }
            return service[action]
         }
      }
      return new Proxy(service, handler)
   }

   return {
      setConnectionCallback,
      setDisconnectionCallback,
      service,
      on,
   }
}


function generateUID(length) {
   const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
   let uid = '';

   for (let i = 0; i < length; i++) {
     const randomIndex = Math.floor(Math.random() * characters.length)
     uid += characters.charAt(randomIndex)
   }
   return uid
}
