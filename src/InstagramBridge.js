var Bridge = require("matrix-appservice-bridge").Bridge;
var RemoteRoom = require("matrix-appservice-bridge").RemoteRoom;
var RemoteUser = require("matrix-appservice-bridge").RemoteUser;
var log = require("./util/LogService");
var ProfileService = require("./instagram/ProfileService");
var PubSub = require("pubsub-js");
var util = require("./util/utils.js");
var WebService = require("./WebService");
var OAuthService = require("./instagram/OAuthService");
var MediaHandler = require("./instagram/MediaHandler");
var _ = require('lodash');
var AdminRoom = require("./matrix/AdminRoom");
var InstagramStore = require("./storage/InstagramStore");
var moment = require('moment');

/**
 * The main entry point for the application - bootstraps the bridge
 */
class InstagramBridge {

    /**
     * Creates a new Instagram Bridge
     * @param {Object} config the configuration file to use
     * @param {AppServiceRegistration} registration the app service registration file
     */
    constructor(config, registration) {
        log.info("InstagramBridge", "Constructing bridge");

        this._config = config;
        this._registration = registration;
        this._adminRooms = {}; // { roomId: AdminRoom }

        WebService.bind(config.web.bind, config.web.port);
        OAuthService.prepare(config.instagram.clientId, config.instagram.clientSecret, config.instagram.publicUrlBase);

        this._bridge = new Bridge({
            registration: this._registration,
            homeserverUrl: this._config.homeserver.url,
            domain: this._config.homeserver.domain,
            controller: {
                onEvent: this._onEvent.bind(this),
                onUserQuery: this._onUserQuery.bind(this),
                onAliasQuery: this._onAliasQuery.bind(this),
                onAliasQueried: this._onAliasQueried.bind(this),
                onLog: (line, isError) => {
                    var method = isError ? log.error : log.verbose;
                    method("matrix-appservice-bridge", line);
                }

                // TODO: thirdPartyLookup support?
            },
            suppressEcho: false,
            queue: {
                type: "none",
                perRequest: false
            },
            intentOptions: {
                clients: {
                    dontCheckPowerLevel: true
                },
                bot: {
                    dontCheckPowerLevel: true
                }
            }
        });

        PubSub.subscribe('profileUpdate', this._onProfileUpdate.bind(this));
        PubSub.subscribe('newMedia', this._onMedia.bind(this));
    }

    /**
     * Starts the bridge on the defined port
     * @param {number} port the port to run the bridge on
     * @return {Promise<>} resolves when the bridge has started
     */
    run(port) {
        log.info("InstagramBridge", "Starting bridge");
        return ProfileService.prepare(this._config.instagram.rateLimitConfig.profileUpdateFrequency, this._config.instagram.rateLimitConfig.profileCacheTime, this._config.instagram.rateLimitConfig.profileUpdatesPerTick)
            .then(() => MediaHandler.prepare(this._config.instagram.clientId, this._config.instagram.clientSecret, this._config.instagram.publicUrlBase))
            .then(() => this._bridge.run(port, this._config))
            .then(() => this._updateBotProfile())
            .then(() => this._bridgeKnownRooms())
            .catch(error => log.error("InstagramBridge", error));
    }

    /**
     * Gets the bridge bot powering the bridge
     * @return {AppServiceBot} the bridge bot
     */
    getBot() {
        return this._bridge.getBot();
    }

    /**
     * Gets the bridge bot as an intent
     * @return {Intent} the bridge bot
     */
    getBotIntent() {
        return this._bridge.getIntent(this._bridge.getBot().getUserId());
    }

    /**
     * Gets the intent for an Instagram virtual user
     * @param {string} handle the Instagram username
     * @return {Intent} the virtual user intent
     */
    getIgUserIntent(handle) {
        var intent = this._bridge.getIntentFromLocalpart("_instagram_" + handle);
        ProfileService.queueProfileCheck(handle); // to make sure their profile is updated
        return intent;
    }

    /**
     * Determines if a user is a bridge user (either the bot or virtual)
     * @param {string} userId the user ID to check
     * @return {boolean} true if the user ID is a bridge user, false otherwise
     */
    isBridgeUser(userId) {
        var isVirtualUser = userId.indexOf("@_instagram_") === 0 && userId.endsWith(":" + this._bridge.opts.domain);
        return isVirtualUser || userId == this._bridge.getBot().getUserId();
    }

    /**
     * Updates the bridge bot's appearance in matrix
     * @private
     */
    _updateBotProfile() {
        log.info("InstagramBridge", "Updating appearance of bridge bot");

        var desiredDisplayName = this._config.instagram.appearance.displayName || "Instagram Bridge";
        var desiredAvatarUrl = this._config.instagram.appearance.avatarUrl || "http://i.imgur.com/DQKje5W.png"; // instagram icon

        var botIntent = this.getBotIntent();

        InstagramStore.getBotAccountData().then(botProfile => {
            var avatarUrl = botProfile.avatarUrl;
            if (!avatarUrl || avatarUrl !== desiredAvatarUrl) {
                util.uploadContentFromUrl(this._bridge, desiredAvatarUrl, botIntent).then(mxcUrl => {
                    log.verbose("InstagramBridge", "Avatar MXC URL = " + mxcUrl);
                    log.info("InstagramBridge", "Updating avatar for bridge bot");
                    botIntent.setAvatarUrl(mxcUrl);
                    botProfile.avatarUrl = desiredAvatarUrl;
                    InstagramStore.setBotAccountData(botProfile);
                });
            }
            botIntent.getProfileInfo(this._bridge.getBot().getUserId(), 'displayname').then(profile => {
                if (profile.displayname != desiredDisplayName) {
                    log.info("InstagramBridge", "Updating display name from '" + profile.displayname + "' to '" + desiredDisplayName + "'");
                    botIntent.setDisplayName(desiredDisplayName);
                }
            });
        });
    }

    /**
     * Called when a profile has been updated
     * @param {string} topic the event name
     * @param {{username: string, profile: {avatarUrl:string, displayName:string}, changed: string}} changes the changes made to the profile
     * @private
     */
    _onProfileUpdate(topic, changes) {
        // Update user aspects
        var intent = this.getIgUserIntent(changes.username);
        if (changes.changed == 'displayName') {
            intent.setDisplayName(changes.profile.displayName + " (Instagram)");
        } else if (changes.changed == 'avatar') {
            util.uploadContentFromUrl(this._bridge, changes.profile.avatarUrl, intent, 'profile.png')
                .then(mxcUrl => intent.setAvatarUrl(mxcUrl));
        } else log.warn("InstagramBridge", "Unrecongized profile update: " + changes.changed);

        // Update room aspects
        this._bridge.getRoomStore().getEntriesByRemoteRoomData({instagram_username: changes.username}).then(remoteRooms => {
            for (var entry of remoteRooms) {
                var roomId = entry.matrix.roomId;
                if (changes.changed == 'avatar') {
                    util.uploadContentFromUrl(this._bridge, changes.profile.avatarUrl, intent, 'profile.png')
                        .then(mxcUrl => this.getBotIntent().setRoomAvatar(roomId, mxcUrl, {}));
                } else if (changes.changed == 'displayName') {
                    this.getBotIntent().setRoomName(roomId, "[Instagram] " + changes.profile.displayName);
                }
            }
        });
    }

    /**
     * Called when new media has been encountered
     * @param {string} topic the event name
     * @param {{media:{type:string, content:{url:string, width: number, height:number}}[],username:string,caption:string,sourceUrl:string,postId:string,userId:number}} media the media that was encountered
     * @private
     */
    _onMedia(topic, media) {
        var userIntent = this.getIgUserIntent(media.username);

        this._getClientRooms(userIntent).then(rooms => {
            // Only upload the media if we actually have rooms to post to
            if (rooms.length == 0) return;

            var mxcUrls = [];
            var promises = [];
            for (var container of media.media) {
                promises.push(this._uploadMedia(container, mxcUrls, media.postId));
            }

            Promise.all(promises).then(() => {
                for (var roomId of rooms) {
                    this._postMedia(roomId, mxcUrls, media.postId, userIntent, media.caption, media.userId, media.sourceUrl);
                }
            });
        });
    }

    /**
     * Posts media to a given matrix room
     * @param {string} roomId the matrix room ID
     * @param {string} content the media content
     * @param {string} postId the media ID
     * @param {Intent} intent the intent to post as
     * @param {string} caption the caption for the media
     * @param {number} userId the bridge user ID
     * @param {string} sourceUrl the source of the media
     * @private
     */
    _postMedia(roomId, content, postId, intent, caption, userId, sourceUrl) {
        var contentPromises = [];
        var eventIds = [];
        for (var media of content) {
            var body = {
                url: media.mxc,
                body: "igmedia-" + postId,
                info: {
                    w: media.container.content.width,
                    h: media.container.content.height
                },
                external_url: sourceUrl
            };

            if (media.container.type == 'video') {
                body['msgtype'] = 'm.video';
                body['info']['mimetype'] = "video/mp4";
            } else {
                body['msgtype'] = 'm.image';
                body['info']['mimetype'] = "image/jpg";
            }

            contentPromises.push(intent.sendMessage(roomId, body).then(event => {
                eventIds.push(event.event_id);
            }));
        }

        Promise.all(contentPromises).then(() => {
            if (!caption) return Promise.resolve();

            return intent.sendMessage(roomId, {
                msgtype: "m.text",
                body: caption,
                external_url: sourceUrl
            });
        }).then(event => {
            if (!event) return Promise.resolve();
            eventIds.push(event.event_id);
        }).then(() => {
            for (var eventId of eventIds) {
                InstagramStore.storeMedia(userId, postId, eventId, roomId);
            }
            InstagramStore.updateMediaExpirationTime(userId, moment().add(this._config.instagram.rateLimitConfig.mediaCheckFrequency, 'hours').valueOf());
        });
    }

    /**
     * Uploads media to a room
     * @param {{media:{type:string, content:{url:string, width: number, height:number}}[],username:string,caption:string,sourceUrl:string,postId:string,userId:number}} mediaContainer media container
     * @param {{container:{media:{type:string, content:{url:string, width: number, height:number}}[],username:string,caption:string,sourceUrl:string,postId:string,userId:number},mxc:string}[]} urls uploaded media urls array
     * @param {string} postId the post ID
     * @return {Promise<>} resolves when upload has been completed
     * @private
     */
    _uploadMedia(mediaContainer, urls, postId) {
        return util.uploadContentFromUrl(this._bridge, mediaContainer.content.url, this.getBotIntent(), "igmedia-" + postId + "." + (mediaContainer.type == 'video' ? 'mp4' : 'jpg'))
            .then(mxcUrl => urls.push({container: mediaContainer, mxc: mxcUrl}));
    }

    /**
     * Get all joined rooms for an Intent
     * @param {Intent} intent the intent to get joined rooms of
     * @return {Promise<string[]>} resolves to an array of room IDs the intent is participating in
     * @private
     * @deprecated This is a hack
     */
    // HACK: The js-sdk doesn't support this endpoint. See https://github.com/matrix-org/matrix-js-sdk/issues/440
    _getClientRooms(intent) {
        // Borrowed from matrix-appservice-bridge: https://github.com/matrix-org/matrix-appservice-bridge/blob/435942dd32e2214d3aa318503d19b10b40c83e00/lib/components/app-service-bot.js#L34-L47
        return intent.getClient()._http.authedRequestWithPrefix(undefined, "GET", "/joined_rooms", undefined, undefined, "/_matrix/client/r0")
            .then(res => {
                if (!res.joined_rooms) return [];
                return res.joined_rooms;
            });
    }

    /**
     * Updates the bridge information on all rooms the bridge bot participates in
     * @private
     */
    _bridgeKnownRooms() {
        this._bridge.getBot().getJoinedRooms().then(rooms => {
            for (var roomId of rooms) {
                this._processRoom(roomId);
            }
        });
    }

    /**
     * Attempts to determine if a room is a bridged room or an admin room, based on the membership and other
     * room information. This will categorize the room accordingly and prepare it for it's purpose.
     * @param {string} roomId the matrix room ID to process
     * @return {Promise<>} resolves when processing is complete
     * @private
     */
    _processRoom(roomId) {
        log.info("InstagramBridge", "Request to bridge room " + roomId);
        return this._bridge.getRoomStore().getLinkedRemoteRooms(roomId).then(remoteRooms => {
            if (remoteRooms.length == 0) {
                // No remote rooms may mean that this is an admin room
                return this._bridge.getBot().getJoinedMembers(roomId).then(members => {
                    var roomMemberIds = _.keys(members);
                    var botIdx = roomMemberIds.indexOf(this._bridge.getBot().getUserId());

                    if (roomMemberIds.length == 2) {
                        var otherUserId = roomMemberIds[botIdx == 0 ? 1 : 0];
                        this._adminRooms[roomId] = new AdminRoom(roomId, this);
                        log.verbose("InstagramBridge", "Added admin room for user " + otherUserId);
                    }
                });
            }

            log.verbose("InstagramBridge", "Room " + roomId + " is bridged to " + remoteRooms.length + " accounts");
            // no other processing required.
        });
    }

    /**
     * Tries to find an appropriate admin room to send the given event to. If an admin room cannot be found,
     * this will do nothing.
     * @param {MatrixEvent} event the matrix event to send to any reasonable admin room
     * @private
     */
    _tryProcessAdminEvent(event) {
        var roomId = event.room_id;

        if (this._adminRooms[roomId]) this._adminRooms[roomId].handleEvent(event);
    }

    /**
     * Destroys an admin room. This will not cause the bridge bot to leave. It will simply de-categorize it.
     * The room may be unintentionally restored when the bridge restarts, depending on the room conditions.
     * @param {string} roomId the room ID to destroy
     */
    removeAdminRoom(roomId) {
        this._adminRooms[roomId] = null;
    }

    /**
     * Bridge handler for generic events
     * @private
     */
    _onEvent(request, context) {
        var event = request.getData();

        this._tryProcessAdminEvent(event);

        if (event.type === "m.room.member" && event.content.membership === "invite") {
            if (this.isBridgeUser(event.state_key)) {
                log.info("InstagramBridge", event.state_key + " received invite to room " + event.room_id);
                return this._bridge.getIntent(event.state_key).join(event.room_id).then(() => this._processRoom(event.room_id));
            }
        }

        // Default
        return Promise.resolve();
    }

    /**
     * Bridge handler for when a room is created from an alias
     * @private
     */
    _onAliasQueried(alias, roomId) {
        return this._processRoom(roomId); // start the bridge to the room
    }

    /**
     * Bridge handler for creating a room from an alias
     * @private
     */
    _onAliasQuery(alias, aliasLocalpart) {
        log.info("InstagramBridge", "Got request for alias #" + aliasLocalpart);

        if (aliasLocalpart.indexOf("_instagram_") !== 0) throw new Error("Invalid alias (" + aliasLocalpart + "): Missing prefix");

        // The server name could contain underscores, but the port won't. We'll try to create a room based on
        // the last argument being a port, or a string if not a number.

        var handle = aliasLocalpart.substring("_instagram_".length);

        var remoteRoom = new RemoteRoom(aliasLocalpart);
        remoteRoom.set("instagram_username", handle);

        var realProfile = null;

        return InstagramStore.hasAuthTokens(handle).then(isAuthed => {
            if (!isAuthed) return Promise.reject(handle + " has not authorized us to use their account");
            return ProfileService.getProfile(handle);
        }).then(profile => {
            realProfile = profile;
            return util.uploadContentFromUrl(this._bridge, profile.avatarUrl, this.getBotIntent(), 'icon.png');
        }).then(avatarMxc => {
            var virtualUserId = "@_instagram_" + handle + ":" + this._bridge.opts.domain;

            var userMap = {};
            userMap[this._bridge.getBot().getUserId()] = 100;
            userMap[virtualUserId] = 50;
            return {
                remote: remoteRoom,
                creationOpts: {
                    room_alias_name: aliasLocalpart,
                    name: "[Instagram] " + realProfile.displayName,
                    visibility: "public",
                    topic: realProfile.username + "'s Instagram feed",
                    invite: [virtualUserId],
                    initial_state: [{
                        type: "m.room.join_rules",
                        content: {join_rule: "public"},
                        state_key: ""
                    }, {
                        type: "m.room.avatar",
                        content: {url: avatarMxc},
                        state_key: ""
                    }, {
                        type: "m.room.power_levels",
                        content: {
                            events_default: 0,
                            invite: 0, // anyone can invite
                            kick: 50,
                            ban: 50,
                            redact: 50,
                            state_default: 50,
                            events: {
                                "m.room.name": 100,
                                "m.room.avatar": 100,
                                "m.room.topic": 100,
                                "m.room.power_levels": 100,
                                "io.t2l.instagram.account_info": 100
                            },
                            users_default: 0,
                            users: userMap
                        },
                        state_key: ""
                    }, {
                        // Add server_info for interested clients
                        type: "io.t2l.instagram.account_info",
                        content: {handle: handle},
                        state_key: ""
                    }]
                }
            };
        }).catch(err => {
            log.error("InstagramBridge", "Failed to create room for alias #" + aliasLocalpart);
            log.error("InstagramBridge", err);
            return Promise.reject(); // send upstream
        });
    }

    /**
     * Bridge handler to update/create user information
     * @private
     */
    _onUserQuery(matrixUser) {
        // Avatar and name will eventually make it back to us from the profile service.
        var handle = matrixUser.localpart.substring('_instagram_'.length); // no dashes in uuid
        ProfileService.queueProfileCheck(handle);
        return Promise.resolve({
            remote: new RemoteUser(matrixUser.localpart)
        });
    }
}

module.exports = InstagramBridge;