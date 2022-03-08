import DOMPurify from 'dompurify'
import { Activities } from './activities.js'
import { ImmerOAuthPopup, DestinationOAuthPopup, tokenToActor } from './authUtils.js'
import { desc } from './utils.js'
import { ImmersSocket } from './streaming.js'
import { clearStore, createStore } from './store.js'

/**
 * @typedef {object} Destination
 * @property {string} name Title of the destination
 * @property {string} url link to visit the destination
 */
/**
 * @typedef {object} Profile
 * @property {string} id - Globally unique identifier (ActivityPub IRI)
 * @property {string} handle - Shorthand globally unique identifier, format: username[home.immer]
 * @property {string} displayName - User's changeable preferred identifier, may contain spaces & symbols
 * @property {string} homeImmer - Domain of imme where user account is registered
 * @property {string} username - User's permanent uniqe identifier within their home immer
 * @property {string} avatarImage - Profile icon url
 * @property {string} avatarGltf - Profile avatar 3d model url
 * @property {string} url - Webpage to view full profile
 */
/**
 * @typedef {object} FriendStatus
 * @property {Profile} profile - Profile object for friend
 * @property {boolean} isOnline - Currently online anywhere in Immers Space
 * @property {string} [locationName] - Name of current or last immer visited
 * @property {string} [locationURL] - URL of current or last immer visited
 * @property {string} statusString - Text description of current status, "Offline" / "Online at..."
 * @property {string} __unsafeStatusHTML - Unsanitized HTML description of current status with link.
 * You must sanitize this string before inserting into the DOM to avoid XSS attacks.
 * @property {string} statusHTML - Sanitize HTML description of current status with link. Safe to insert into DOM.
 */

/**
 * @typedef {object} Message
 * @property {string} id - URL of original message object, usable as unique id
 * @property {Profile} sender - Message sender's Profile
 * @property {Date} timestamp - Message sent time
 * @property {string} type - Describes the message content: 'chat', 'media', 'status', or 'other'
 * @property {string} __unsafeMessageHTML - Unsanitized HTML message content.
 * You must sanitize this string before inserting into the DOM to avoid XSS attacks.
 * @property {string} messageHTML - Sanitized HTML message content. Safe to insert into DOM. Media wrapped in IMG/VIDEO will have class immers-message-media
 * @property {string} [mediaType] - 'image' or 'video' if the message is a media object
 * @property {string} [mediaURL] - source url if the message is a media object
 * (messageHTML will contain appropriate tags to display the media, but mediaURL can be used if you need custom display)
 */

/**
 * @typedef {object} ImmersClientNewMessageEvent
 * @property {object} detail
 * @property {Message} detail.message
 */

/**
 * High-level interface to Immers profile and social features
 * @fires immers-client-connected
 * @fires immers-client-disconnected
 * @fires immers-client-friends-update
 * @fires immers-client-new-message
 */
export class ImmersClient extends window.EventTarget {
  activities
  streaming
  /**
   * User's Immers profile
   * @type {Profile}
   * @public
   */
  profile
  /**
   * Is the client connected to the User's immer?
   * @type {boolean}
   * @public
   */
  connected = false
  #store
  /**

   * @param  {(Destination|APPlace|string)} destinationDescription Metadata about this destination used when sharing
   * @param  {object} [options]
   * @param  {string} [options.localImmer] Origin of the local Immers Server, if there is one
   * @param  {boolean} [options.allowStorage] Enable localStorage of handle & token for reconnection (make sure you've provided complaince notices as needed)
   */
  constructor (destinationDescription, options) {
    super()
    this.#setPlaceFromDestination(destinationDescription)
    if (!this.place.id) {
      // fake AP IRI for destinations without their own immer
      this.place.id = this.place.url
    }
    this.localImmer = options?.localImmer
    this.allowStorage = options?.allowStorage
    this.#store = createStore(this.allowStorage)
    try {
      const hashParams = new URLSearchParams(window.location.hash.substring(1))
      if (hashParams.has('me')) {
        this.#store.handle = hashParams.get('me')
        // restore original hash
        hashParams.delete('me')
        window.location.hash = hashParams.toString().replace(/=$/, '')
      }
    } catch (err) {
      console.warn(`Unable to parse handle from URL hash: ${err.message}`)
    }
  }

  /**
   * Connect to user's Immers Space profile, using pop-up window for OAuth
   * @param  {string} tokenCatcherURL Page on your domain that runs {@link catchToken} on load to retrieve the granted access token.
   * Can be the same page as long as loading it again in a pop-up won't cause a the main session to disconnect.
   * @param  {string} requestedRole Access level to request, see {@link roles} for details
   * @param  {string} [handle] User's immers handle. Optional if you have a local Immers Server
   * @returns {string} token OAuth2 acess token
   */
  async login (tokenCatcherURL, requestedRole, handle) {
    let authResult
    if (this.localImmer) {
      authResult = await ImmerOAuthPopup(this.localImmer, this.place.id, requestedRole, tokenCatcherURL, handle)
    } else {
      authResult = await DestinationOAuthPopup(handle, requestedRole, tokenCatcherURL)
    }
    const { actor, token, homeImmer, authorizedScopes } = authResult
    this.#store.credential = { token, homeImmer, authorizedScopes }
    this.#setupAfterLogin(actor, homeImmer, token, authorizedScopes)
    return token
  }

  /**
   * Attempt to restore session from a previously granted token. Requires options.allowStorage
   * @returns {Promise<boolean>} Was reconnection successful
   */
  async restoreSession () {
    try {
      const { token, homeImmer, authorizedScopes } = this.#store.credential
      const actor = await tokenToActor(token, homeImmer)
      if (actor) {
        this.#setupAfterLogin(actor, homeImmer, token, authorizedScopes)
        return true
      }
    } catch {}
    return false
  }

  /**
   * Mark user as "online" at this immer and share the location with their friends.
   * Must be called after successful {@link login} or {@link restoreSession}
   */
  async enter () {
    if (!this.connected) {
      throw new Error('Immers login required to udpate location')
    }
    const { authorizedScopes } = this.#store.credential
    const actor = this.activities.actor
    if (this.streaming.connected) {
      await this.activities.arrive()
      this.streaming.prepareLeaveOnDisconnect(actor, this.place)
    }
    // also update on future (re)connections
    this.streaming.addEventListener('immers-socket-connect', () => {
      if (authorizedScopes.includes('postLocation')) {
        this.activities.arrive()
        this.streaming.prepareLeaveOnDisconnect(actor, this.place)
      }
    })
  }

  /**
   * Update user's current online location and share with friends
   * @param  {(Destination|APPlace|string)} destinationDescription
   */
  async move (destinationDescription) {
    if (!this.connected) {
      throw new Error('Immers login required to update location')
    }
    await this.activities.leave()
    this.#setPlaceFromDestination(destinationDescription)
    return this.enter()
  }

  /**
   * Mark user as no longer online at this immer.
   */
  exit () {
    if (!this.connected) {
      throw new Error('Immers login required to update location')
    }
    return this.activities.leave()
  }

  /**
   * Disconnect from User's immer, retaining credentials to reconnect
   */
  disconnect () {
    this.streaming.disconnect()
    this.streaming = undefined
    this.activities = undefined
    this.connected = false
    /**
     * Fired when disconnected from immers server or logged out
     * @event immers-client-disconnected
     */
    this.dispatchEvent(new window.CustomEvent('immers-client-disconnected'))
  }

  /**
   * Disconnect from User's immer and delete any traces of user identity
   */
  logout () {
    clearStore(this.#store)
    this.disconnect()
  }

  /**
   * Update user's profile description
   * @param {object} info
   * @param  {string} [info.displayName] User's preferred shorthand identifier, may contain spaces & symbols
   * @param  {string} [info.bio] Summary paragraph displayed on user profile
   */
  updateProfileInfo ({ displayName, bio }) {
    let somethingUpdated
    const update = {}
    if (displayName) {
      update.name = displayName
      somethingUpdated = true
    }
    if (bio) {
      update.summary = bio
      somethingUpdated = true
    }
    if (somethingUpdated) {
      return this.activities.updateProfile(update)
    }
  }

  #setupAfterLogin (actor, homeImmer, token, authorizedScopes) {
    this.connected = true
    this.profile = ImmersClient.ProfileFromActor(actor)
    this.#store.handle = this.profile.handle
    this.activities = new Activities(actor, homeImmer, this.place, token)
    this.streaming = new ImmersSocket(homeImmer, token)

    if (authorizedScopes.includes('viewFriends')) {
      this.#publishFriendsUpdate()
      this.streaming.addEventListener(
        'immers-socket-friends-update',
        () => this.#publishFriendsUpdate()
      )
    }
    if (authorizedScopes.includes('viewPublic')) {
      this.streaming.addEventListener(
        'immers-socket-inbox-update',
        event => this.#publishIncomingMessage(event.detail)
      )
    }
    /**
     * User has connected to the immers server
     * @event immers-client-connected
     * @type {object}
     * @property {Profile} detail.profile the connected user's profile
     */
    this.dispatchEvent(new window.CustomEvent('immers-client-connected', { detail: { profile: this.profile } }))
  }

  /**
   * Fetch list of friends and their online status and location
   * @returns {Promise<FriendStatus[]>}
   */
  async friendsList () {
    const friendsCol = await this.activities.friends()
    return friendsCol.orderedItems
      .map(ImmersClient.FriendStatusFromActivity)
  }

  /**
   * Fetch a page of recent activity Messages
   * @returns {Promise<Message[]>}
   */
  async feed () {
    const inboxCol = await this.activities.inbox()
    const outboxCol = await this.activities.outbox()
    console.log('collections', inboxCol, outboxCol)
    return inboxCol.orderedItems
      .concat(outboxCol.orderedItems)
      .map(ImmersClient.MessageFromActivity)
      .filter(msg => !!msg) // posts not convertable to Message
      .sort(desc('timestamp'))
  }

  async #publishFriendsUpdate () {
    /**
     * Friends status/location has changed
     * @event immers-client-friends-update
     * @type {object}
     * @property {FriendStatus[]} detail.friends Current status for each friend
     */
    const evt = new window.CustomEvent('immers-client-friends-update', {
      detail: {
        friends: await this.friendsList()
      }
    })
    this.dispatchEvent(evt)
  }

  #publishIncomingMessage (activity) {
    const message = ImmersClient.MessageFromActivity(activity)
    if (!message) {
      // activity type was not convertable to chat message
      return
    }
    /**
     * New chat or status message received
     * @event immers-client-new-message
     * @type {ImmersClientNewMessageEvent}
     */
    const evt = new window.CustomEvent('immers-client-new-message', {
      detail: { message }
    })
    this.dispatchEvent(evt)
  }

  /**
   * Users Immers handle, if known. May be available even when logged-out if passed via URL or stored from past login
   * @type {string}
   */
  get handle () {
    return this.#store.handle
  }

  /**
   * Extract friend status information from their most recent location activity
   * @param  {APActivity} activity
   * @returns {FriendStatus}
   */
  static FriendStatusFromActivity (activity) {
    const isOnline = activity.type === 'Arrive'
    const locationName = activity.target?.name
    const locationURL = activity.target?.url
    const statusString = isOnline
      ? `Online at ${locationName} (${locationURL})`
      : 'Offline'
    const __unsafeStatusHTML = isOnline
      ? `<span>Online at <a href="${locationURL}">${locationName}</a></span>`
      : '<span>Offline</span>'
    return {
      profile: ImmersClient.ProfileFromActor(activity.actor),
      isOnline,
      locationName,
      locationURL,
      statusString,
      __unsafeStatusHTML,
      statusHTML: DOMPurify.sanitize(__unsafeStatusHTML)
    }
  }

  /**
   * Extract a Message from an activity object
   * @param  {APActivity} activity
   * @returns {Message | null}
   */
  static MessageFromActivity (activity) {
    /** @type {Message} */
    const message = {
      id: activity.id,
      type: 'other',
      sender: ImmersClient.ProfileFromActor(activity.actor),
      timestamp: activity.published ? new Date(activity.published) : new Date()
    }
    message.__unsafeMessageHTML = activity.object?.content || activity.content
    switch (activity.type) {
      case 'Create':
        switch (activity.object?.type) {
          case 'Note':
            message.type = 'chat'
            message.__unsafeMessageHTML = activity.object.content
            break
          case 'Image':
            message.type = 'media'
            message.mediaType = 'image'
            message.url = activity.object.url
            message.__unsafeMessageHTML = `<img class="immers-message-media" src=${activity.object.url} crossorigin="anonymous">`
            break
          case 'Video':
            message.type = 'media'
            message.mediaType = 'video'
            message.url = activity.object.url
            message.__unsafeMessageHTML = `<video class="immers-message-media" controls autplay muted plasinline src=${activity.object.url} crossorigin="anonymous">`
            break
        }
        break
      case 'Arrive':
      case 'Leave':
        message.type = 'status'
        message.__unsafeMessageHTML = activity.summary
        break
      case 'Follow':
        // ignore automated follow-backs
        if (!activity.inReplyTo) {
          message.type = 'status'
          message.__unsafeMessageHTML = activity.summary || '<span>Sent you a friend request</span>'
        }
        break
      case 'Accept':
        message.type = 'status'
        message.__unsafeMessageHTML = activity.summary || '<span>Accepted your friend request</span>'
        break
      default:
        message.__unsafeMessageHTML = activity.summary
    }
    if (!message.__unsafeMessageHTML) {
      return null
    }
    message.messageHTML = DOMPurify.sanitize(message.__unsafeMessageHTML)
    return message
  }

  /**
   * Convert ActivityPub Actor format to Immers profile
   * @param  {APActor} actor - ActivityPub Actor object
   * @returns {Profile}
   */
  static ProfileFromActor (actor) {
    const { id, name: displayName, preferredUsername: username, icon, avatar, url } = actor
    const homeImmer = new URL(id).host
    return {
      id,
      handle: `${username}[${homeImmer}]`,
      homeImmer,
      displayName,
      username,
      avatarImage: ImmersClient.URLFromProperty(icon),
      avatarModel: ImmersClient.URLFromProperty(avatar),
      url: url ?? id
    }
  }

  /**
   * Links in ActivityPub objects can take a variety of forms.
   * Find and return the URL string.
   * @param  {APObject|object|string} prop
   * @returns {string} URL string
   */
  static URLFromProperty (prop) {
    return prop?.url?.href ?? prop?.url ?? prop
  }

  #setPlaceFromDestination (destinationDescription) {
    this.place = Object.assign(
      { type: 'Place', audience: Activities.PublicAddress },
      destinationDescription
    )
    if (this.activities) {
      this.activities.place = this.place
    }
  }

  /**
   * Connect to user's Immers Space profile, using pop-up window for OAuth if needed
   * @param  {string} tokenCatcherURL Page on your domain that runs {@link catchToken} on load to retrieve the granted access token.
   * Can be the same page as long as loading it again in a pop-up won't cause a the main session to disconnect.
   * @param  {string} requestedRole Access level to request, see {@link roles} for details
   * @param  {string} [handle] User's immers handle. Optional if you have a local Immers Server
   * @deprecated Split into to methods, {@link login} and {@link enter}, for better control over when a user goes online
   * @returns {string} token OAuth2 acess token
   */
  async connect (tokenCatcherURL, requestedRole, handle) {
    const { token } = await this.login(tokenCatcherURL, requestedRole, handle)
    this.enter()
    return token
  }

  /**
   * Attempt to restore session from a previously granted token. Requires options.allowStorage
   * @returns {Promise<boolean>} Was reconnection successful
   * @deprecated Split into to methods, {@link restoreSession} and {@link enter}, for better control over when a user goes online
   */
  async reconnect () {
    if (await this.restoreSession()) {
      this.enter()
      return true
    }
    return false
  }
}
