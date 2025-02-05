import DOMPurify from 'dompurify'
import { Activities } from './activities.js'
import { ImmerOAuthPopup, DestinationOAuthPopup, tokenToActor, SCOPES, preprocessScopes } from './authUtils.js'
import { desc, getURLPart, parseHandle } from './utils.js'
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
 * @property {object} collections - Map of user collections retrievable with getCollection. Always includes 'blocked' (user blocklist) and 'avatars'
 */
/**
 * @typedef {object} FriendStatus
 * @property {Profile} profile - Profile object for friend
 * @property {boolean} isOnline - Currently online anywhere in Immers Space
 * @property {string} [locationName] - Name of current or last immer visited
 * @property {string} [locationURL] - URL of current or last immer visited
 * @property {('friend-online'|'friend-offline'|'request-receved'|'request-sent'|'none')} status - descriptor of the current relationship to this user
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
  /**
   * Activities instance for access to low-level ActivityPub API
   * @type {Activities}
   * @public
   */
  activities
  /**
   * ImmersSocket instance for access to low-level streaming API
   * @type {ImmersSocket}
   * @public
   */
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

   * @param  {(Destination|APPlace|string)} destinationDescription Metadata about this destination used when sharing or url for the related Place object. Either a Destination/APPlace object or a url where one can be fetched.
   * @param  {object} [options]
   * @param  {string} [options.localImmer] Domain (host) of the local Immers Server, if there is one
   * @param  {boolean} [options.allowStorage] Enable localStorage of handle & token for reconnection (make sure you've provided complaince notices as needed)
   */
  constructor (destinationDescription, options) {
    super()
    this.localImmer = options?.localImmer ? getURLPart(options.localImmer, 'host') : undefined
    this.allowStorage = options?.allowStorage
    this.enterBound = () => this.enter()
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
    if (this.localImmer) {
      // some functionality enabled prior to login when local immer present
      this.activities = new Activities({}, this.localImmer, this.place, null, this.localImmer)
    }
    this.#setPlaceFromDestination(destinationDescription).then(() => {
      if (!this.place.id) {
        // fake AP IRI for destinations without their own immer
        this.place.id = this.place.url
      }
    })
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
   * Initialize client with an existing credential,
   * e.g. one obtained through a service account
   * @param  {string} token - OAuth2 Access Token
   * @param  {string} homeImmer - Domain (host) for user's home immer
   * @param  {(string|string[])} authorizedScopes - Scopes authorized for the token
   * @returns {Promise<boolean>} true if the login was successful
   */
  loginWithToken (token, homeImmer, authorizedScopes) {
    homeImmer = getURLPart(homeImmer, 'origin')
    authorizedScopes = preprocessScopes(authorizedScopes)
    this.#store.credential = { token, homeImmer, authorizedScopes }
    return this.restoreSession()
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
   *  @param  {(Destination|APPlace|string)} [destinationDescription]
   */
  async enter (destinationDescription) {
    // optionally update the place before going online
    if (destinationDescription) {
      await this.#setPlaceFromDestination(destinationDescription)
    }
    if (!this.connected) {
      throw new Error('Immers login required to udpate location')
    }
    if (!this.#store.credential.authorizedScopes.includes(SCOPES.postLocation)) {
      console.info('Not sharing location because not authorized')
      return
    }
    const actor = this.activities.actor
    if (this.streaming.connected) {
      await this.activities.arrive()
      this.streaming.prepareLeaveOnDisconnect(actor, this.place)
    }
    // also update on future (re)connections
    this.streaming.addEventListener('immers-socket-connect', this.enterBound)
  }

  /**
   * Update user's current online location and share with friends
   * @param  {(Destination|APPlace|string)} destinationDescription
   */
  async move (destinationDescription) {
    if (!this.connected) {
      throw new Error('Immers login required to update location')
    }
    if (!this.#store.credential.authorizedScopes.includes(SCOPES.postLocation)) {
      console.info('Not sharing location because not authorized')
      return
    }
    await this.exit()
    return this.enter(destinationDescription)
  }

  /**
   * Mark user as no longer online at this immer.
   */
  async exit () {
    if (!this.connected) {
      throw new Error('Immers login required to update location')
    }
    if (!this.#store.credential.authorizedScopes.includes(SCOPES.postLocation)) {
      console.info('Not sharing location because not authorized')
      return
    }
    await this.activities.leave()
    this.streaming.clearLeaveOnDisconnect()
    this.streaming.removeEventListener('immers-socket-connect', this.enterBound)
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
    this.activities = new Activities(actor, homeImmer, this.place, token, this.localImmer)
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
    this.#store.friends = friendsCol.orderedItems
      .map(ImmersClient.FriendStatusFromActivity)
    return friendsCol.orderedItems
      // don't show ex-friends in list
      .filter(activity => activity.type !== 'Reject')
      // map it again to avoid shared, mutable objects
      .map(ImmersClient.FriendStatusFromActivity)
      .sort(ImmersClient.FriendsSorter)
  }

  /**
   * Fetch a page of recent activity Messages
   * @returns {Promise<Message[]>}
   */
  async feed () {
    const inboxCol = await this.activities.inbox()
    const outboxCol = await this.activities.outbox()
    return inboxCol.orderedItems
      .concat(outboxCol.orderedItems)
      .map(ImmersClient.MessageFromActivity)
      .filter(msg => !!msg) // posts not convertable to Message
      .sort(desc('timestamp'))
  }

  /**
   * Send a message with text content.
   * Privacy level determines who receives and can acccess the message.
   * Direct: Only those named in `to` receive the message.
   * Friends: Direct plus friends list.
   * Public: Direct plus Friends plus accessible via URL for sharing.
   * @param {string} content - The text/HTML content. Will be sanitized before sending
   * @param {string} privacy - 'direct', 'friends', or 'public'
   * @param {string[]} [to] - Addressees. Accepts Immers handles (username[domain.name]) and ActivityPub IRIs
   * @returns {Promise<string>} Url of newly posted message
   */
  sendChatMessage (content, privacy, to = []) {
    return this.activities.note(DOMPurify.sanitize(content), to, privacy)
  }

  /**
   * This method will either initiate a new friend request or,
   * if a request has already been received from the target user,
   * accept a pending friend request. To create a friend connection,
   * both users will need to call this method with the other user's handle.
   * @param  {string} handle - the target user's immers handle or profile id
   */
  async addFriend (handle) {
    const userId = handle.startsWith('https://') ? handle : await this.resolveProfileIRI(handle)
    const pendingRequest = this.#store.friends?.find(status => status.profile.id === userId && status.status === 'request-received')
    if (pendingRequest) {
      return this.activities.accept(pendingRequest._activity)
    }
    return this.activities.follow(userId)
  }

  /**
   * Remove a relationship to another immerser,
   * either by removing an existing friend,
   * rejecting a pending incoming friend request,
   * or canceling a pending outgoing friend request
   * @param  {string} handle - the target user's immers handle or profile id
   */
  async removeFriend (handle) {
    const userId = handle.startsWith('https://') ? handle : await this.resolveProfileIRI(handle)
    const pendingRequest = this.#store.friends
      ?.find(status => status.profile.id === userId && status.status === 'request-received')
    if (pendingRequest) {
      return this.activities.reject(pendingRequest._activity.id, userId)
    }
    const pendingOutgoingRequest = this.#store.friends
      ?.find(status => status.profile.id === userId && status.status === 'request-sent')
    if (pendingOutgoingRequest) {
      return this.activities.undo(pendingOutgoingRequest._activity)
    }
    // technically reject needs the original follow activity ID, but
    // immers server will do this lookup for us if we send reject of a friends list user id
    return this.activities.reject(userId, userId)
  }

  /*
   * Upload a 3d model as an avatar and optionally share it
   * @param  {string} name - Name/description
   * @param  {Blob} glb - 3d model gltf binary file
   * @param  {Blob} icon - Preview image for thumbnails
   * @param  {string} privacy - 'direct', 'friends', or 'public'
   * @param  {} [to] - Addressees. Accepts Immers handles (username[domain.name]) and ActivityPub IRIs
   * @returns {Promise<string>} Url of avatar creation post
   */
  createAvatar (name, glb, icon, privacy, to = []) {
    return this.activities.model(name, glb, icon, to, privacy)
  }

  /**
   * Add an existing avatar to a user's personal avatar collection
   * @param  {(string|APActivity)} sourceActivity - Create activity for the avatar or IRI of activity (other activities with the avatar as their object, e.g. Offer, also allowed)
   */
  addAvatar (sourceActivity) {
    return this.activities.add(sourceActivity, this.profile.collections.avatars)
  }

  /**
   * Update user's avatar in their profile.
   * @param  {(object|string)} avatar - Model type object or id for one (or activity containing the model as its object)
   */
  async useAvatar (avatar) {
    // if IRI, fetch object
    if (typeof avatar === 'string') {
      avatar = await this.activities.getObject(avatar)
    }
    // if Activity, extract object
    if (avatar.object) {
      avatar = avatar.object
    }
    if (!ImmersClient.URLFromProperty(avatar?.url)) {
      throw new Error('Invalid avatar')
    }
    const profileUpdate = { avatar }
    const icon = ImmersClient.URLFromProperty(avatar.icon)
    if (icon) {
      profileUpdate.icon = icon
    }
    return this.activities.updateProfile(profileUpdate)
  }

  // Misc utilities
  /**
   * Attempt to fetch a cross-domain resource.
   * Prefers using the local immer's proxy service if available,
   * falling back to the user's home immer's proxy service if available or plain fetch.
   * @param  {string} url - resource to GET
   * @param  {object} headers - fetch headers
   */
  async corsProxyFetch (url, headers) {
    if (this.localImmer) {
      // prefer direct local fetch or local proxy if possible
      return window.fetch(
        url.startsWith(`https://${this.localImmer}`) ? url : `https://${this.localImmer}/proxy/${url}`,
        { headers }
      )
    }
    const homeProxy = this.activities?.actor?.endpoints?.proxyUrl
    if (homeProxy) {
      try {
        headers = {
          ...headers,
          Authorization: `Bearer ${this.store.credential.token}`
        }
        // note this GET proxy is different from the ActivityPub standard POST proxy used for AP objects
        const result = await window.fetch(`${homeProxy}/${url}`, {
          headers
        })
        if (!result.ok) {
          throw new Error(`Fetch failed: ${result.statusText} ${result.body}`)
        }
        return result
      } catch (err) {
        console.log('Home immer CORS proxy failed', err.message)
      }
    }
    console.warn('No local immer nor user-provided proxy available, attempting normal fetch')
    return window.fetch(url, {
      headers
    })
  }

  /**
   * Get a user ID/URL from their handle using webfinger
   * @param  {string} handle - immers handle
   * @returns {string | undefined} - The profile IRI or undefined if failed
   */
  async resolveProfileIRI (handle) {
    if (this.#store.cachedHandleIRIs?.[handle]) {
      return this.#store.cachedHandleIRIs[handle]
    }
    const { username, immer } = parseHandle(handle)
    const finger = await this.corsProxyFetch(
      `https://${immer}/.well-known/webfinger?resource=acct:${username}@${immer}`,
      { headers: { Accept: 'application/json' } }
    )
      .then(res => res.json())
      .catch(err => {
        console.error(`Could not resolve profile webfinger ${err.message}`)
        return undefined
      })
    const iri = finger?.links?.find?.((l) => l.rel === 'self')?.href
    if (iri) {
      this.#store.cachedHandleIRIs = {
        ...this.#store.cachedHandleIRIs || {},
        [handle]: iri
      }
    }
    return iri
  }

  /**
   * Get a user's profile object from their handle.
   * Uses logged-in users's home immer proxy service if available
   * @param {string} handle - Immers handle
   * @returns {Profile | undefined} - User profile or undefined if failed
   */
  async getProfile (handle) {
    if (this.#store.cachedActors?.[handle]) {
      return ImmersClient.ProfileFromActor(this.#store.cachedActors[handle])
    }
    let actor
    const iri = await this.resolveProfileIRI(handle)
    if (!iri) {
      return
    }
    if (this.connected) {
      actor = await this.activities.getObject(iri).catch(() => {})
    }
    if (!actor) {
      actor = await this.corsProxyFetch(iri, { Accept: Activities.JSONLDMime })
        .then(res => res.json())
        .catch(() => {})
    }
    if (actor) {
      this.#store.cachedActors = {
        ...this.#store.cachedActors || {},
        [handle]: actor
      }
      return ImmersClient.ProfileFromActor(actor)
    }
  }

  async getNodeInfo (handle) {
    const { immer } = parseHandle(handle)
    if (this.#store.cachedNodeInfos?.[immer]) {
      return this.#store.cachedNodeInfos[immer]
    }
    const headers = { Accept: 'application/json' }
    const resource = await this.corsProxyFetch(
      `https://${immer}/.well-known/nodeinfo`,
      { headers }
    )
      .then(res => res.json())
      .catch(err => {
        console.error(`Could not resolve nodeinfo links ${err.message}`)
        return undefined
      })
    const url = (
      resource?.links?.find((l) => l.rel === Activities.NodeInfoV21) ||
      resource?.links?.find((l) => l.rel === Activities.NodeInfoV20)
    )?.href
    if (!url) {
      return
    }
    const info = await this.corsProxyFetch(url, { headers })
      .then(res => res.json())
      .catch(err => {
        console.error(`Could not resolve nodeinfo ${err.message}`)
        return undefined
      })
    if (info) {
      this.#store.cachedNodeInfos = {
        ...this.#store.cachedNodeInfos || {},
        [immer]: info
      }
    }
    return info
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
   * Array.sort compareFunction to sort a friends list putting online
   * friends at the top and the rest by most recent update
   * @param  {FriendStatus} a
   * @param  {FriendStatus} b
   */
  static FriendsSorter (a, b) {
    if (a.status === 'friend-online' && b.status !== 'friend-online') {
      return -1
    }
    if (b.status === 'friend-online' && a.status !== 'friend-online') {
      return 1
    }
    if (a._activity.published === b._activity.published) {
      return 0
    }
    return a._activity.published > b._activity.published ? -1 : 1
  }

  /**
   * Extract friend status information from their most recent location activity
   * @param  {APActivity} activity
   * @returns {FriendStatus}
   */
  static FriendStatusFromActivity (activity) {
    const locationName = activity.target?.name
    const locationURL = activity.target?.url
    let status = 'none'
    let statusString = ''
    let __unsafeStatusHTML = '<span></span>'
    let actor = activity.actor
    switch (activity.type.toLowerCase()) {
      case 'arrive':
        status = 'friend-online'
        statusString = `Online at ${locationName} (${locationURL})`
        __unsafeStatusHTML = `<span>Online at <a href="${locationURL}">${locationName}</a></span>`
        break
      case 'leave':
      case 'accept':
        status = 'friend-offline'
        statusString = 'Offline'
        __unsafeStatusHTML = `<span>${statusString}</span>`
        break
      case 'follow':
        if (actor.id) {
          status = 'request-received'
          statusString = 'Sent you a friend request'
          __unsafeStatusHTML = `<span>${statusString}</span>`
        } else if (activity.object?.id) {
          // for outgoing request, current user is the actor; we're interested in the object
          actor = activity.object
          status = 'request-sent'
          statusString = 'You sent a friend request'
          __unsafeStatusHTML = `<span>${statusString}</span>`
        }
        break
    }
    const isOnline = status === 'friend-online'
    const friendStatus = {
      profile: ImmersClient.ProfileFromActor(actor),
      isOnline,
      locationName,
      locationURL,
      status,
      statusString,
      __unsafeStatusHTML,
      statusHTML: DOMPurify.sanitize(__unsafeStatusHTML)
    }
    Object.defineProperty(friendStatus, '_activity', { enumerable: false, value: activity })
    return friendStatus
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
      url: url ?? id,
      collections: actor.streams
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

  async #setPlaceFromDestination (destinationDescription) {
    if (typeof destinationDescription === 'string') {
      this.place = await window.fetch(destinationDescription, {
        headers: { Accept: Activities.JSONLDMime }
      }).then(res => res.json())
    } else {
      const defaultPlace = { type: 'Place', audience: Activities.PublicAddress }
      const basePlace = this.localImmer
        ? await window.fetch(`${getURLPart(this.localImmer, 'origin')}/o/immer`, {
            headers: { Accept: Activities.JSONLDMime }
          }).then(res => res.json()).catch(() => defaultPlace)
        : defaultPlace
      this.place = Object.assign(
        basePlace,
        destinationDescription
      )
    }
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
    const token = await this.login(tokenCatcherURL, requestedRole, handle)
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
