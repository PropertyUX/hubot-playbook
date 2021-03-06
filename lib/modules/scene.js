'use strict'

const _ = require('lodash')
const Base = require('./base')
const Dialogue = require('./dialogue')
const Middleware = require('../utils/middleware')
require('../utils/string-to-regex')

/**
 * Scenes conduct participation in dialogue. They use listeners to enter an
 * audience into a new dialogue with the bot.
 *
 * Once entered into a scene, the audience is engaged and isolated from global
 * listeners. The bot will only respond to branches defined by dialogue in that
 * scene. The scope of audience can be:
 *
 * - user - engage the user (in any room)
 * - room - engage the whole room
 * - direct - engage the user in that room only
 *
 * @param {Robot} robot                   Hubot Robot instance
 * @param {Object} [options]              Key/val options for config
 * @param {string} [options.scope]        How to address participants: user(default)|room|direct
 * @param {boolean} [options.sendReplies] Toggle replying/sending (prefix message with "@user")
 * @param {string} [key]                  Key name for this instance
 *
 * @example
 * let roomScene = new Scene(robot, { scope: 'room' })
*/
class Scene extends Base {
  constructor (...args) {
    super('scene', ...args)
    this.defaults({ scope: 'user' })

    // setup internal middleware stack for processing entry
    this.enterMiddleware = new Middleware(this)

    // by default, prefix @user in room scene (to identify target recipient)
    if (this.config.scope === 'room') this.defaults({ sendReplies: true })
    if (this.config.scope === 'private') this.defaults({ sendDirect: true })

    const validTypes = [ 'room', 'user', 'direct', 'private' ]
    if (!_.includes(validTypes, this.config.scope)) this.error('invalid scene scope')

    this.engaged = {}
    this.middlewareCallback = this.receiveMiddleware.bind(this)
    this.robot.receiveMiddleware(this.middlewareCallback)

    this.timeoutListeners = {}
    this.endListeners = {}
  }

  receiveMiddleware (c, n, d) {
    this.middleware(c, n, d)
  }

  /**
   * Process incoming messages, re-route to dialogue for engaged participants.
   *
   * @param {Object} context Passed through the middleware stack, with res
   * @param {Function} next  Called when all middleware is complete
   * @param {Function} done  Initial (final) completion callback
  */
  middleware (context, next, done) {
    const res = context.response
    const participants = this.whoSpeaks(res)

    // are incoming messages from this scenes' engaged participants
    if (participants in this.engaged) {
      this.log.debug(`${participants} is engaged, routing dialogue.`)
      res.finish() // don't process regular listeners
      this.engaged[participants].receive(res) // let dialogue handle the response
      done() // don't process further middleware.
    } else {
      this.log.debug(`${participants} not engaged, continue as normal.`)
      next(done)
    }
  }

  /**
   * Add listener that enters the audience into the scene with callback to add
   * dialogue branches or process response as required.
   *
   * Enter callback provides full middleware context, but for consistency with
   * other listener callbacks, response is extracted and given as the first
   * argument, full context is second.
   *
   * Middleware may prevent callback, e.g. from Director if user denied access.
   *
   * @param  {String} type       The listener type: hear|respond
   * @param  {RegExp} regex      Matcher for listener (accepts string)
   * @param  {Function} callback Called with response and middleware context
   *                             after listener matched and scene entered
   *
   * @example
   * let scene = new Scene(robot, { scope: 'user' })
   * scene.listen('respond', /hello/, (res) => {
   *   res.reply('you are now in a scene')
   *   // add dialogue branches now...
   * })
  */
  listen (type, regex, callback) {
    if (!_.includes(['hear', 'respond'], type)) this.error('Invalid listener type')
    if (_.isString(regex) && _.isRegExp(regex.toRegExp())) regex = regex.toRegExp()
    if (!_.isRegExp(regex)) this.error('Invalid regex for listener')
    if (!_.isFunction(callback)) this.error('Invalid callback for listener')

    this.robot[type](regex, { id: this.id }, (res) => {
      this.enter(res, (context) => callback(context.response, context))
      .catch((err) => this.log.debug(`Scene enter interrupted for ${regex} listener: ${err}`))
    })
  }

  /**
   * Alias of Scene.listen with `hear` as specified type.
  */
  hear (...args) {
    return this.listen('hear', ...args)
  }

  /**
   * Alias of Scene.listen with `respond` as specified type.
  */
  respond (...args) {
    return this.listen('respond', ...args)
  }

  /**
   * Identify the source of a message relative to the scene scope.
   *
   * @param  {Response} res Hubot Response object
   * @return {string}       ID of room, user or composite
  */
  whoSpeaks (res) {
    switch (this.config.scope) {
      case 'room': return res.message.room.toString()
      case 'user':
      case 'private':
        return res.message.user.id.toString()
      case 'direct': return `${res.message.user.id}_${res.message.room}`
    }
  }

  /**
    * Add a function to the enter middleware stack, to continue or interrupt the
    * pipeline. Called with:
    * - bound 'this' containing the current scene
    * - context, object containing relevant attributes for the pipeline
    * - next, function to call to continue the pipeline
    * - done, final pipeline function, optionally given as argument to next
    *
    * @param  {Function} piece Pipeline function to add to the stack.
   */
  registerMiddleware (piece) {
    this.enterMiddleware.register(piece)
  }

  /*
   * Trigger scene enter middleware to begin, calling optional callback if/when
   * pipeline completes. Processing may reject promise, so should be caught.
   *
   * If middleware succeeds the callback is called. If the callback doesn't set
   * up dialogue paths to carry forward an interaction, there's nothing left for
   * the scene to do and it will exit immediately. This may be helpful for
   * one-time interactions that make use of the scene for it's access control
   * middleware and transcript record.
   *
   * The returned promise resolves when middleware completes *before* the final
   * callback, to allow yielding instead of using callback to add dialogue path,
   * so the path exists when the callback checks to see if it should exit.
   *
   * @param  {Response} res        Hubot Response object
   * @param  {Object} [options]    Dialogue options merged with scene config
   * @param  {*} args              Any additional args for Dialogue constructor
   * @param  {Function} [callback] Called if middleware completed entry, with final context
   * @return {Promise}             Resolves with new Dialogue middleware completes
  */
  enter (res, ...args) {
    const participants = this.whoSpeaks(res)
    if (this.inDialogue(participants)) return Promise.reject(new Error('Already engaged'))

    // pull-out relevant arguments (any remaining are added to context)
    let callback = (_.isFunction(args[ args.length - 1 ]))
      ? args.pop()
      : () => null
    let options = _.isObject(args[0]) ? args.shift() : {}
    options = _.defaults({}, this.config, options)

    // setup middleware completion / failure handlers
    let next = this.processEnter.bind(this)
    let done = (context) => {
      if (context.dialogue) { // middleware succeeded and set up dialogue
        Promise.resolve(callback(context))
        .then(() => process.nextTick(() => {
          if (context.dialogue.path !== null) return
          this.exit(context.response, 'no path')
        }))
      }
    }

    // setup context and execute middleware stack, calling processEnter as
    // final step if pipeline is allowed to complete
    return this.enterMiddleware.execute({
      response: res,
      participants: participants,
      options: options,
      arguments: args
    }, next, done)
  }

  /**
   * Engage the participants in dialogue. A new Dialogue instance is created and
   * all further messages from the audience in this scene's scope will be passed
   * to that dialogue, untill they are exited from the scene.
   *
   * Would usually be invoked as the final piece of enter middleware, after
   * stack execution is triggered by a scene listener but could be called
   * directly to force audience into a scene unprompted.
   *
   * @param  {Object} context              The final context after middleware completed
   * @param  {Object} context.response     The hubot response object
   * @param  {string} context.participants Who is being entered to the scene
   * @param  {Object} [context.options]    Options object given to dialogue
   * @param  {Array}  [context.arguments]  Additional arguments given to dialogue
   * @param  {Function} [done]             Optional final callback after processed - given context
   * @return {Promise}                     Resolves with callback called in next tick queue
   */
  processEnter (context, done) {
    let args = Array.from(context.arguments)
    const dialogue = new Dialogue(context.response, context.options, ...args)
    dialogue.scene = this
    if (!dialogue.key && this.key) dialogue.key = this.key
    this.timeoutListeners[this.whoSpeaks(dialogue.res)] = dialogue.on('timeout', (lastRes, other) => {
      return this.exit(lastRes, 'timeout')
    })
    this.endListeners[this.whoSpeaks(dialogue.res)] = dialogue.on('end', (lastRes) => {
      let isComplete = (lastRes.dialogue.path) ? lastRes.dialogue.path.closed : false
      return this.exit(lastRes, `${(isComplete) ? '' : 'in'}complete`)
    })
    this.engaged[context.participants] = dialogue
    this.emit('enter', context.response, dialogue)
    this.log.info(`Engaging ${this.config.scope} ${context.participants} in dialogue`)
    context.dialogue = dialogue
    return process.nextTick(done, context)
  }

  /**
   * Disengage participants from dialogue e.g. in case of timeout or error.
   *
   * @param  {Response} res    Hubot Response object
   * @param  {string} [status] Some context, for logs
   * @return {boolean}         Exit success (may fail if already disengaged)
  */
  exit (res, status = 'unknown') {
    const participants = this.whoSpeaks(res)
    if (this.engaged[participants] != null) {
      this.engaged[participants].clearTimeout()
      delete this.engaged[participants]
      // cleanup our event listeners
      this.robot.events.removeListener('timeout', this.timeoutListeners[participants])
      delete this.timeoutListeners[participants]

      this.robot.events.removeListener('end', this.endListeners[participants])
      delete this.endListeners[participants]

      this.emit('exit', res, status)
      this.log.info(`Disengaged ${this.config.scope} ${participants} (${status})`)
      return true
    }
    this.log.debug(`Cannot disengage ${participants}, not in scene`)
    return false
  }

  /**
   * End all engaged dialogues.
  */
  exitAll () {
    this.log.info(`Disengaging all in ${this.config.scope} scene`)
    _.invokeMap(this.engaged, 'clearTimeout')
    this.engaged = []
  }

  /**
   * Get the dialogue for engaged participants (relative to scene scope).
   *
   * @param  {string} participants ID of user, room or composite
   * @return {Dialogue}            Engaged dialogue instance
  */
  getDialogue (participants) {
    return this.engaged[participants]
  }

  /**
   * Get the engaged status for participants.
   *
   * @param  {string} participants ID of user, room or composite
   * @return {boolean}             Is engaged status
  */
  inDialogue (participants) {
    return (_.includes(_.keys(this.engaged), participants))
  }
}

module.exports = Scene
