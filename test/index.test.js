
import bodyParser from 'body-parser'
import axios from 'axios'
import io from 'socket.io-client'
import { PrismaClient } from '@prisma/client'


import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'

import { expressX } from '@jcbuisson/express-x'
import expressXClient from '../src/index.mjs'

const prisma = new PrismaClient({
   datasources: {
      db: {
         url: "file:./dev.db",
      },
   },
})

// `app` is a regular express application, enhanced with services and real-time features
const app = expressX(prisma)


describe('HTTP/REST API', () => {

   let chris

   before(async () => {
      console.log("before")
      // add body parsers for http requests
      app.use(bodyParser.json())
      app.use(bodyParser.urlencoded({ extended: false }))

      app.createDatabaseService('User')
      app.createDatabaseService('Post')

      await app.service('User').deleteMany()
      await app.service('Post').deleteMany()

      // add http/rest endpoints
      app.addHttpRest('/api/user', app.service('User'))
      app.addHttpRest('/api/post', app.service('Post'))

      await new Promise((resolve) => {
         app.server.listen(8008, () => {
            console.log(`App listening at http://localhost:8008`)
            resolve()
         })
      })
   })

   after(() => {
      console.log("after")
      app.server.close()
   })

   it("can create a user", async () => {
      const res = await axios.post('http://localhost:8008/api/user', {
         name: "chris",
         email: 'chris@mail.fr'
      })
      assert(res?.data?.name === 'chris')
   })

   it("can find users", async () => {
      const res = await axios.get('http://localhost:8008/api/user')
      assert(res?.data?.length > 0)
   })

   it("can find a user by name", async () => {
      const res = await axios.get('http://localhost:8008/api/user?name=chris')
      assert(res?.data?.length > 0)
      chris = res.data[0]
   })

   it("can find a user by id", async () => {
      const res = await axios.get(`http://localhost:8008/api/user/${chris.id}`)
      assert(res?.data?.id === chris.id)
   })

   it("can patch a user", async () => {
      const res = await axios.patch(`http://localhost:8008/api/user/${chris.id}`, {
         name: "Christophe",
      })
      assert(res?.data?.name === "Christophe")
   })

   it("can delete a user", async () => {
      const res = await axios.delete(`http://localhost:8008/api/user/${chris.id}`)
      assert(res?.data?.name === "Christophe")
   })

   after(async () => {
      app.server.close()
   })
})


// test compatibility with client API
describe('Client API', () => {

   let clientApp, socket

   before(async () => {
      await new Promise((resolve) => {
         app.server.listen(8008, () => {
            console.log(`App listening at http://localhost:8008`)
            resolve()
         })
      })

      socket = io('http://localhost:8008', { transports: ["websocket"] })
      clientApp = expressXClient(socket)
   })

   after(async () => {
      app.server.close()
   })

   it("can create a user", async () => {
      const user = await clientApp.service('User').create({
         data: {
            name: "chris",
            email: 'chris@mail.fr'
         },
      })
      assert(user.name === 'chris')
   })

   after(async () => {
      await socket.close()
      await app.server.close()
   })
})
