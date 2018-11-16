// @flow

/* flow-include
type optionsObjectOrString = string|{
  host?: string,
  port?: number,
  lazyConnect?: boolean
}
*/

const Redis = require('ioredis')
const EventEmitter = require('events')

const defaultOptions = {
  lazyConnect: false,
  serialize: JSON.stringify,
  unserialize: JSON.parse,
  // Amount of time to wait on XREAD - ideally we call client UNBLOCK on-demand, so this tunable shouldn't really matter much
  blockingInterval: 10000,
  redisOptions: { showFriendlyErrorStack: true }
}

// $FlowIssue (logger takes any number of arguments)
function logger () {
  if (process.env.RSA_DEBUG === 'true') console.log.apply(console, arguments) // eslint-disable-line
}

function RedisStreamsAggregator (options /*: optionsObjectOrString */) {
  // Stores a list of subscriptions by subscription key, with the value as Array<subscribers, offset>
  this.subscriptions = {}
  // Indicates if the read stream is currently blocked by an XREAD call
  this.readStreamActive = false
  this.events = new EventEmitter()
  this.isReady = false
  this.on = this.events.on
  // Default options
  if (typeof options === 'string') options = { host: options }
  this.options = Object.assign({}, defaultOptions, options)

  // Create redis read & write handles with debugable connection names
  const r = `${Math.floor(Math.random() * 10000000)}`
  const readName = `read:${r}`
  const writeName = `write:${r}`
  this.handles = {
    read: new Redis(Object.assign(this.options, { connectionName: readName })),
    write: new Redis(Object.assign(this.options, { connectionName: writeName })),
    readName,
    writeName
  }
  logger('RedisStreamsAggregator()', { ...this.options, readName, writeName })

  // We need to retrieve the read connections "client id" so that we can call CLIENT UNBLOCK on it later
  const getReadClientId = () => {
    if (this.handles.read.status === 'connect' && this.handles.write.status === 'connect') {
      this.handles.read.client('id').then(id => {
        this.readId = id
        this.events.emit('ready', true)
      })
    }
  }

  this.handles.write.on('connect', getReadClientId)
  this.handles.read.on('connect', getReadClientId)

  this.handles.write.on('error', err => console.error('RedisStreamsAggregator write handle error:', err))
  this.handles.read.on('error', err => console.error('RedisStreamsAggregator read handle error:', err))

  let currentlyConnecting = false

  // Class methods below
  this.connect = function () {
    return new Promise((resolve, reject) => {
      if (this.isReady) return resolve()
      if (!currentlyConnecting) {
        currentlyConnecting = true
        if (!['connect', 'connecting'].includes(this.handles.read.status)) this.handles.read.connect()
        if (!['connect', 'connecting'].includes(this.handles.write.status)) this.handles.write.connect()
      }

      this.events.on('ready', ready => {
        this.isReady = true
        currentlyConnecting = false
        resolve()
      })
      this.events.on('end', () => {
        currentlyConnecting = false
        reject()
      })
    })
  }

  this.disconnect = function () {
    return new Promise(async (resolve, reject) => {
      this.events.removeAllListeners()
      await this.unblock()
      this.readId = false
      this.handles.read.on('end', async () => {
        await this.handles.write.disconnect()
      })
      this.handles.write.on('end', () => resolve())
      await this.handles.read.disconnect()
    })
  }

  this.unsubscribe = async function (id /*: string */, onEvent /*: Function */) {
    await this.connect()
    if (!this.subscriptions[id]) return
    if (this.subscriptions[id][0] > 0) {
      this.events.removeListener(id, onEvent)
      this.subscriptions[id][0] -= 1
    }
    if (this.subscriptions[id][0] === 0) delete this.subscriptions[id]
  }

  this.subscribe = async function (id /*: string */, offset /*: string */, onEvent /*: Function */) {
    await this.connect()
    if (!this.subscriptions[id]) {
      this.subscriptions[id] = [1, offset]
      this.readStream()
    } else {
      this.subscriptions[id][0] += 1
    }
    this.events.on(id, onEvent)
  }

  this.add = async function (id /*: string */, content /*: Object */, msgId = '*') {
    await this.connect()
    const body = typeof content === 'object' ? this.options.serialize(content) : content
    logger('XADD', [id, msgId, 's', body])
    return this.handles.write.xadd(id, msgId, 's', body)
  }

  this.unblock = async function () {
    await this.connect()
    this.readStreamActive = false
    return this.handles.write.client('unblock', this.readId)
  }

  this.readStream = async function () {
    await this.connect()
    if (this.readStreamActive) await this.unblock()
    this.readStreamActive = true

    const streamIds = []
    const streamOffsets = []
    for (const id in this.subscriptions) {
      streamIds.push(id)
      streamOffsets.push(this.subscriptions[id][1])
    }
    if (streamIds.length < 1) return
    logger('XREAD', ['BLOCK', this.options.blockingInterval, 'STREAMS', ...streamIds, ...streamOffsets])
    const messages = await this.handles.read.xread(
      'BLOCK',
      this.options.blockingInterval,
      'STREAMS',
      ...streamIds,
      ...streamOffsets
    )
    this.readStreamActive = false
    if (typeof this.readId !== 'number') return
    if (messages) {
      for (let i = 0; i < messages.length; i++) {
        const newEventId = messages[i][0]
        if (this.subscriptions[newEventId]) {
          const eventMessagesRaw = messages[i][1]
          const eventMessages = eventMessagesRaw.map(r => {
            r[1] = this.options.unserialize(r[1][1])
            return r
          })
          this.subscriptions[newEventId].offset = eventMessages[eventMessages.length - 1][0]
          this.events.emit(newEventId, eventMessages)
        }
      }
    }
    await this.readStream()
  }

  return this
}

module.exports = RedisStreamsAggregator
