
function generateUID(length) {
   const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
   let uid = '';

   for (let i = 0; i < length; i++) {
     const randomIndex = Math.floor(Math.random() * characters.length)
     uid += characters.charAt(randomIndex)
   }
   return uid
}


export default function expressXClient(socket, options={}) {
   if (options.debug === undefined) options.debug = false

   const waitingPromisesByUid = {}
   const action2service2handlers = {}
   const type2appHandler = {}
   const socketConnectionState = {}

   socket.on("connect", async () => {
      console.log("socket connected", socket.id)
      if (socketConnectionState.resolve) {
         socketConnectionState.resolve('ok')
         socketConnectionState.status = 'connected'
      }
   })

   socket.on("error", async () => {
      console.log("socket connection error", socket.id)
      if (socketConnectionState.reject) {
         socketConnectionState.reject(err)
         socketConnectionState.status = 'error'
      }
   })

   async function socketConnection() {
      const promise = new Promise((resolve, reject) => {
         socketConnectionState.resolve = resolve
         socketConnectionState.reject = reject
      })
      return promise
   }

   function socketStatus() {
      return socketConnectionState.status
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
   
   async function serviceMethodRequest(name, action, options, ...args) {
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

   function service(name, options={ timeout: 5000 }) {
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
               service[action] = (...args) => serviceMethodRequest(name, action, options, ...args)
            }
            return service[action]
         }
      }
      return new Proxy(service, handler)
   }

   ///////////////         APPLICATION-LEVEL EVENTS         /////////////////

   // There is a need for events sent outside any service method call, for example on unsolicited-by-frontend backend state change
   socket.on('app-event', ({ type, value }) => {
      if (options.debug) console.log('app-event', type, value)
      if (!type2appHandler[type]) type2appHandler[type] = {}
      const handler = type2appHandler[type]
      if (handler) handler(value)
   })

   // add application event handler
   function on(type, handler) {
      type2appHandler[type] = handler
   }

   return {
      socketConnection,
      socketStatus,
      service,
      on,
   }
}

