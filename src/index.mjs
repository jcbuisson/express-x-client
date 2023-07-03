
import { v4 } from 'uuid'

export default function expressXClient(socket, options={}) {
   if (options.debug === undefined) options.debug = false

   const waitingPromisesByUid = {}
   const action2service2handlers = {}
   let onConnectionCallback = null
   let onDisconnectionCallback = null

   const setConnectionCallback = (callback) => {
      onConnectionCallback = callback
   }

   const setDisconnectionCallback = (callback) => {
      onDisconnectionCallback = callback
   }

   // on connection
   socket.on("connected", async (connectionId) => {
      if (options.debug) console.log('connected', connectionId)
      // look in sessionStorage for a previously stored connection id
      const prevConnectionId = sessionStorage.getItem('expressx-cnx-id')
      if (prevConnectionId) {
         // it's a reconnection
         if (prevConnectionId < 0) {
            // ask server to transfer all data from connection `prevConnectionId` to connection `connectionId`
            if (options.debug) console.log('cnx-transfer', -prevConnectionId, 'to', connectionId)
            socket.emit('cnx-transfer', {
               from: -prevConnectionId,
               to: connectionId,
            })
         } else {
            if (options.debug) console.log('Error, previous connection id should be negative', prevConnectionId)
         }

      } else {
         // set/update connection id in sessionStorage
         sessionStorage.setItem('expressx-cnx-id', connectionId)
      }
      // call user-defined connection callback
      if (onConnectionCallback) onConnectionCallback(connectionId)
   })

   socket.on("cnx-transfer-ack", async (connectionId) => {
      if (options.debug) console.log('cnx-transfer-ack', connectionId)
      sessionStorage.setItem('expressx-cnx-id', connectionId)
   })


   // A negative value for session storage 'expressx-cnx-id' means that the connection with the server has been lost
   // Requests must wait until it goes positive again

   // disconnection due to network issues
   socket.on("disconnect", async (cause) => {
      // alert('disconnect')
      const id = sessionStorage.getItem('expressx-cnx-id')
      if (id > 0) {
         sessionStorage.setItem('expressx-cnx-id', -id)
         sessionStorage.setItem('cause1', 'disconnect')
      } else {
         if (options.debug) console.log('Error (disconnect), connection id should be negative', id)
      }
   })

   // disconnection due to a page reload
   window.addEventListener('unload', () => {
      const id = sessionStorage.getItem('expressx-cnx-id')
      if (id > 0) {
         sessionStorage.setItem('expressx-cnx-id', -id)
         sessionStorage.setItem('cause2', 'unload')
      } else {
         if (options.debug) console.log('Error (unload), connection id should be negative', id)
      }
   })


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

   // on receiving events from pub/sub
   socket.on('service-event', ({ name, action, result }) => {
      if (!action2service2handlers[action]) action2service2handlers[action] = {}
      const serviceHandlers = action2service2handlers[action]
      const handler = serviceHandlers[name]
      if (handler) handler(result)
   })

   function wait(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
   }

   async function serviceMethodRequest(name, action, ...args) {
      // wait while session storage 'expressx-cnx-id' is negative (= connection is lost with server)
      let retries = 10
      while (retries-- > 0) {
         const id = sessionStorage.getItem('expressx-cnx-id')
         if (id > 0) break
         console.log('negative!!', id)
         await wait(200)
      }

      // create a promise which will resolve or reject by an event 'client-response'
      const uid = v4()
      const promise = new Promise((resolve, reject) => {
         waitingPromisesByUid[uid] = [resolve, reject]
         // a 5s timeout may also reject the promise
         setTimeout(() => {
            delete waitingPromisesByUid[uid]
            reject(`Error: timeout on service '${name}', action '${action}', args: ${JSON.stringify(args)}`)
         }, 5000)
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
   }
}
