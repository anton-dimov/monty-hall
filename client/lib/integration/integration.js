(function (define) {
	"use strict";

	var freeze, undef;

	freeze = Object.freeze || function (obj) { return obj; };

	define(['./channels/dispatchers/broadcast', 'when'], function (broadcastDispatcher, when) {

		var busCounter;

		/**
		 * Detect if the first parameter is a name. If the param is omitted,
		 * arguments are normalized and passed to the wrapped function.
		 * Behavior will be undesirable if the second argument may be a string.
		 * @param {Function} func function who's first parameter is a name that
		 * may be ommited.
		 */
		function optionalName(func) {
			return function (name) {
				var args = Array.prototype.slice.call(arguments);
				if (typeof name !== 'string') {
					// use empty string instead of undef so that this optionalName helpers can be stacked
					args.unshift('');
				}
				return func.apply(this, args);
			};
		}

		/**
		 * Incrementing counter
		 */
		function counter() {
			/*jshint plusplus:false */
			var count = 0;

			return function increment() {
				return count++;
			};
		}

		/**
		 * Create a new message
		 * @param {Object} payload content of the message
		 * @param {Object} [headers] meta data for the message
		 */
		function Message(payload, headers) {
			this.payload = payload;
			this.headers = freeze(headers || {});
			freeze(this);
		}

		Message.prototype = {

			/**
			 * Create a new message from this message overriding certain
			 * headers with the provided values. The current message is not
			 * modfieid.
			 * @params {Object} [payload] payload for the new message, defaults
			 * to the current message payload
			 * @params {Object} declaredHeaders headers that overwrite the current
			 * message's headers
			 * @return {Message} a new message with the same payload and new
			 * headers
			 */
			mixin: function mixin(payload, declaredHeaders) {
				var headers;

				if (arguments.length < 2) {
					declaredHeaders = payload;
					payload = this.payload;
				}
				declaredHeaders = declaredHeaders || {};
				headers = {};

				Object.keys(this.headers).forEach(function (header) {
					headers[header] = this.headers[header];
				}, this);
				Object.keys(declaredHeaders).forEach(function (header) {
					headers[header] = declaredHeaders[header];
				}, this);

				return new Message(payload, headers);
			}

		};

		/**
		 * Holds a reference to a channel or handler that can be resolved
		 * later. Useful for shareing components outside of their home bus.
		 */
		function Ref(resolver) {
			this.resolve = resolver;
		}

		/**
		 * @returns true if a Ref
		 */
		function isRef(ref) {
			return ref instanceof Ref;
		}

		/**
		 * Create a new message bus
		 * @param {MessageBus} [parent] a parent message bus to extend from
		 */
		function MessageBus(parent) {
			var components = {},
				children = [],
				busId = busCounter(),
				messageCounter = counter();

			/**
			 * @param {Function} [config] configuration helper invoked in the
			 * context of the bus.
			 * @returns a new message bus who's parent is the current bus
			 */
			this.bus = function bus(config) {
				var messageBus = new MessageBus(this);
				children.push(messageBus);
				if (config) {
					config.call(messageBus, messageBus);
				}
				return messageBus;
			};

			/**
			 * Create a new message
			 * @param {Object|Message} payload the message payload
			 * @param {Object} [declaredHeaders] the message headers
			 * @returns the new message
			 */
			this._message = function _message(payload, declaredHeaders) {
				var headers;

				headers = {};
				declaredHeaders = declaredHeaders || {};
				Object.keys(declaredHeaders).forEach(function (header) {
					headers[header] = declaredHeaders[header];
				}, this);

				headers.id = busId + '-' + messageCounter();

				return this.isMessage(payload) ?
					payload.mixin(headers) :
					new Message(payload, headers);
			};

			/**
			 * Find a handler by name. If the handler is not found in the local
			 * message bus, the parent message bus is queried.
			 * @param {String|Handler} name the handler name to find
			 * @returns the found handler, undefined when not found
			 */
			this.resolveHandler = function resolveHandler(name) {
				var handler;
				if (this.isHandler(name)) {
					return name;
				}
				if (name in components) {
					handler = components[name];
					if (isRef(handler)) {
						handler = handler.resolve();
					}
					return this.resolveHandler(handler);
				}
				if (parent) {
					return parent.resolveHandler(name);
				}
			};

			/**
			 * Find a channel by name. If the channel is not found in the local
			 * message bus, the parent message bus is queried.
			 * @param {String|Channel} name the channel name to find
			 * @returns the found channel, undefined when not found
			 */
			this.resolveChannel = function resolveChannel(name) {
				var channel;
				if (this.isChannel(name)) {
					return name;
				}
				if (name in components) {
					channel = components[name];
					if (isRef(channel)) {
						channel = channel.resolve();
					}
					return this.resolveChannel(channel);
				}
				if (parent) {
					return parent.resolveChannel(name);
				}
			};

			/**
			 * Create an alias for a handler or channel
			 * @param {String} name the alias
			 * @param {String|Channel|Handler} component the item to register
			 */
			this.alias = function alias(name, component) {
				if (!(this.resolveChannel(component) || this.resolveHandler(component) || isRef(component))) {
					throw new Error('Unable to alias: handler or channel is required');
				}
				if (!name) {
					throw new Error('Unable to aslias: name is required');
				}
				if (name in components) {
					throw new Error('Unable to aslias: the name \'' + name + '\' is in use');
				}
				components[name] = component;
			};

			/**
			 * Dead letter channel that handles messages that were sent, but
			 * have no handlers.
			 */
			this.deadLetterChannel = this._channel('deadLetterChannel', broadcastDispatcher());

			/**
			 * Invalid message channel that handles messages when an error was
			 * encountered sending the message.
			 */
			this.invalidMessageChannel = this._channel('invalidMessageChannel', broadcastDispatcher());

			if (parent) {
				// share messages with parent's channels
				this.deadLetterChannel.subscribe(this.forward(parent.deadLetterChannel));
				this.invalidMessageChannel.subscribe(this.forward(parent.invalidMessageChannel));

				/**
				 * Make a channel available to the parent bus. Useful for
				 * defining contained sub flows that provide entry and exit
				 * points.
				 * @param {String} [name] the name to export as
				 * @param {String|Channel} channel the channel to export
				 */
				this.exportChannel = function exportChannel(name, channel) {
					if (arguments.length === 1) {
						channel = name;
					}
					parent.alias(name, new Ref(function () {
						return this.resolveChannel(channel);
					}.bind(this)));
				};

				/**
				 * Deconstructor that cleans up any linguring state that would
				 * not be automatically garbage collected
				 */
				this.destroy = function destroy() {
					children.forEach(function (bus) {
						bus.destroy();
					});
					Object.keys(components).forEach(function (name) {
						var component = components[name];
						if (component.destroy) {
							component.destroy();
						}
						delete components[name];
					}, this);
					this.deadLetterChannel.destroy();
					this.invalidMessageChannel.destroy();
				};
			}
		}

		MessageBus.prototype = {

			/**
			 * @returns true if the object is a message
			 */
			isMessage: function isMessage(message) {
				return message instanceof Message;
			},

			/**
			 * @returns true if the object can handle messages
			 */
			isHandler: function isHandler(handler) {
				return handler && typeof handler.handle === 'function';
			},

			/**
			 * @returns true if the object can send messages
			 */
			isChannel: function isChannel(channel) {
				return channel && typeof channel.send === 'function';
			},

			/**
			 * @returns true is the object is a message bus
			 */
			isBus: function isBus(bus) {
				return bus instanceof MessageBus;
			},

			/**
			 * Create a new channel to pass messages
			 * @param {String} [name] the name to register this channel under
			 * @param {Dispatcher} dispatcher dispatching strategy for this channel
			 * @returns {Channel} a new channel
			 */
			_channel: function _channel(name, dispatcher) {
				var channel = {
					send: function send(message) {
						try {
							if (!dispatcher.dispatch(message, this.resolveHandler.bind(this))) {
								if (channel !== this.deadLetterChannel) {
									this.send(this.deadLetterChannel, message);
								}
							}
						}
						catch (e) {
							if (channel !== this.invalidMessageChannel) {
								this.send(this.invalidMessageChannel, message, { error: e });
							}
						}
					}.bind(this)
				};

				Object.keys(dispatcher.channelMixins || {}).forEach(function (prop) {
					channel[prop] = dispatcher.channelMixins[prop];
				});

				if (name) {
					this.alias(name, channel);
				}

				return channel;
			},

			/**
			 * Create a new handler
			 * @param {String} [name] the name to register this handler under
			 * @param {Function} transform function to transform the message
			 * @param {String|Channel} [outputChannel] where to forward the
			 * handled message
			 * @param {String|Channel} [inputChannel] channel to receive
			 *  messages from
			 * @param {String|Channel} [errorChannel] where to forward the
			 * message when an error occurs
			 * @returns a new handler
			 */
			_handler: function _handler(name, transform, outputChannel, inputChannel, errorChannel) {
				var handler = {
					handle: function handle(message, outputChannelOverride) {
						var payload, nextOutput, nextError;
						try {
							nextOutput = outputChannelOverride || outputChannel || message.headers.replyChannel;
							nextError = errorChannel || message.headers.errorChannel;
							payload = transform.call(this, message, nextOutput, nextError);
							if (payload && nextOutput) {
								this.send(nextOutput, payload, message.headers);
							}
						}
						catch (e) {
							if (nextError) {
								this.send(nextError, message, { error: e });
							}
							else {
								throw e;
							}
						}
					}.bind(this)
				};

				if (name) {
					this.alias(name, handler);
				}
				if (inputChannel && this.subscribe) {
					// TODO support pollable channels?
					this.subscribe(inputChannel, handler);
				}

				return handler;
			},

			/**
			 * Create and send a message to a channel
			 * @param {String|Channel} channel the channel to sent the message to
			 * @param {Object|Message} payload the message to send
			 * @param {Object} [headers] headers for the message
			 */
			send: function send(channel, payload, headers) {
				this.resolveChannel(channel).send(this._message(payload, headers));
			},

			/**
			 * Forward a message to a channel
			 * @param {String} [name] the name to register the forward as
			 * @param {String|Channel} target the channel to forward to
			 */
			forward: function forward(name, target) {
				// optionalName won't work since target may be a string
				if (arguments.length < 2) {
					target = name;
					name = '';
				}
				return this._handler(name, function (message) {
					return message;
				}, target);
			},

			/**
			 * Treat an array of handlers as if they are a single handler. Each
			 * handler is executed in order with the message from the previous
			 * handler in the pipeline.
			 * @param {String} [name] the name to register the pipeline as
			 * @param {Array[Handler]} handlers array of handlers
			 * @param {String|Channel} [opts.output] the channel to forward
			 * messages to
			 * @param {String|Channel} [opts.input] the channel to receive
			 * message from
			 * @param {String|Channel} [opts.error] channel to receive errors
			 * @returns the pipeline
			 */
			pipeline: optionalName(function pipeline(name, handlers, opts) {
				opts = opts || {};
				return this._handler(name, function (message) {
					handlers.map(this.resolveHandler, this).forEach(function (handler) {
						if (!message) { return; }
						handler.handle(message, {
							send: function send(m) {
								message = m;
								return true;
							}
						});
					}, this);
					return message;
				}, opts.output, opts.input, opts.error);
			}),

			/**
			 * Transform messages sent to this channel
			 * @param {String} [name] the name to register the transform as
			 * @param {Function} translator transform function, invoked with
			 * message payload and message headers as args, a new payload
			 * must be returned.
			 * @param {String|Channel} [opts.output] the channel to forward
			 * transformed messages to
			 * @param {String|Channel} [opts.input] the channel to receive
			 * message from
			 * @param {String|Channel} [opts.error] channel to receive errors
			 * @returns the transform
			 */
			transform: optionalName(function transform(name, translator, opts) {
				opts = opts || {};
				return this._handler(name, function (message) {
					return message.mixin(translator.call(undef, message.payload, message.headers), {});
				}, opts.output, opts.input, opts.error);
			}),

			/**
			 * Filter messages based on some criteria. Abandoned messages may
			 * be forward to a discard channel if defined.
			 * @param {String} [name] the name to register the filter as
			 * @param {Function} rule filter function, invoked with message
			 * payload and message headers as args. If true is returned, the
			 * message is forwarded, otherwise it is discarded.
			 * @param {String|Channel} [opts.output] the channel to forward
			 * messages to
			 * @param {String|Channel} [opts.discard] channel to handle
			 * discarded messages
			 * @param {String|Channel} [opts.input] the channel to receive
			 * message from
			 * @param {String|Channel} [opts.error] channel to receive errors
			 * @returns the filter
			 */
			filter: optionalName(function filter(name, rule, opts) {
				opts = opts || {};
				return this._handler(name, function (message) {
					if (rule.call(this, message.payload, message.headers)) {
						return message;
					}
					else if (opts.discard) {
						this.send(opts.discard, message, { discardedBy: name });
					}
				}, opts.output, opts.input, opts.error);
			}),

			/**
			 * Route messages to handlers defined by the rule. The rule may
			 * return 0..n recipient channels.
			 * @param {String} [name] the name to register the router as
			 * @param {Function} rule function that accepts the message and
			 * defined routes returning channels to route the message to
			 * @param {Object|Array} [opts.routes] channel aliases for the router
			 * @param {String|Channel} [opts.input] the channel to receive
			 * message from
			 * @param {String|Channel} [opts.error] channel to receive errors
			 * @returns the router
			 */
			router: optionalName(function router(name, rule, opts) {
				opts = opts || {};
				return this._handler(name, function (message) {
					var recipients = rule.call(this, message, opts.routes);
					if (!(recipients instanceof Array)) {
						recipients = [recipients];
					}
					opts.routes = opts.routes || {};
					recipients.forEach(function (recipient) {
						this.send(recipient in opts.routes ? opts.routes[recipient] : recipient, message);
					}, this);
				}, this.noopChannel, opts.input, opts.error);
			}),

			/**
			 * Split one message into many
			 * @param {String} [name] the name to register the splitter as
			 * @param {Function} rule function that accepts a message and
			 * returns an array of messages
			 * @param {String|Channel} [opts.output] the channel to forward
			 * split messages to
			 * @param {String|Channel} [opts.input] the channel to receive
			 * message from
			 * @param {String|Channel} [opts.error] channel to receive errors
			 * @returns the splitter
			 */
			splitter: optionalName(function splitter(name, rule, opts) {
				opts = opts || {};
				return this._handler(name, function (message) {
					rule.call(this, message).forEach(function (splitMessage, index, splitMessages) {
						this.send(opts.output, splitMessage, {
							sequenceNumber: index,
							sequenceSize: splitMessages.length,
							correlationId: message.headers.id
						});
					}, this);
				}, this.noopChannel, opts.input, opts.error);
			}),

			/**
			 * Aggregate multiple messages into a single message
			 * @param {String} [name] the name to register the aggregator as
			 * @param {Function} strategy function that accepts a message and
			 * a callback function. When the strategy determins a new message
			 * is ready, it must invoke the callback fucntion with that
			 * message.
			 * @param {String|Channel} [opts.output] the channel to forward
			 * aggregated messages to
			 * @param {String|Channel} [opts.input] the channel to receive
			 * message from
			 * @param {String|Channel} [opts.error] channel to receive errors
			 * @returns the aggregator
			 */
			aggregator: optionalName(function aggregator(name, correlator, opts) {
				opts = opts || {};
				var release = function (payload, headers) {
					this.send(opts.output, payload, headers);
				}.bind(this);
				return this._handler(name, function (message) {
					correlator.call(this, message, release);
				}, this.noopChannel, opts.input, opts.error);
			}),

			/**
			 * Log meesages at the desired level
			 * @param {String} [name] the name to register the logger as
			 * @param {Console} [opts.console=console] the console to log with
			 * @param {String} [opts.level='log'] the console level to log at,
			 * defaults to 'log'
			 * @param {Object|String} [opts.prefix] value included with the
			 * logged message
			 * @param {String|Channel} [opts.input] the channel to log messages
			 * from
			 * @returns the logger
			 */
			logger: optionalName(function logger(name, opts) {
				opts = opts || {};
				opts.console = opts.console || console;
				opts.level = opts.level || 'log';
				return this._handler(name, function (message) {
					var output = 'prefix' in opts ?
						[opts.prefix, message] :
						[message];
					opts.console[opts.level].apply(opts.console, output);
				}, this.noopChannel, opts.input);
			}),

			/**
			 * Post messages to a channel that can be invoked as a JS function.
			 * The first argument of the returned function becomes the message
			 * payload.
			 * @param {String|Channel} output the channel to post messages to
			 * @param {Function} [adapter] function to adapt the arguments into
			 * a message payload. The function must return a message payload.
			 * @returns a common function that will send messages
			 */
			inboundAdapter: function inboundAdapter(output, adapter) {
				var counter = this.utils.counter();
				adapter = adapter || this.utils.noop;
				return function () {
					var payload = adapter.apply(arguments[0], arguments);
					if (payload !== undef) {
						this.send(output, payload, { sequenceNumber: counter() });
					}
				}.bind(this);
			},

			/**
			 * Bridge a handler to a common function. The function is invoked
			 * as messages are handled with the message payload provided as an
			 * argument.
			 * @param {String} [name] the name to register the adapter as
			 * @param {Function} func common JS function to invoke
			 * @retuns {Handler} the handler for this adapter
			 */
			outboundAdapter: optionalName(function outboundAdapter(name, func) {
				return this._handler(name, function (message) {
					func.call(undef, message.payload);
				});
			}),

			/**
			 * Gateway between application code that expects a reply and the
			 * message bus. Similar to an inbound adapter, however, the
			 * returned function itself returns a promise representing the
			 * outcome of the message.
			 * @param {String|Channel} output the channel to post messages to
			 * @returns {Function} a function that when invoked places a
			 * message on the bus that returns a promise representing the
			 * outcome of the message
			 */
			gateway: function gateway(output) {
				return function (payload) {
					var message, defer;

					defer = when.defer();
					this.send(output, payload, {
						replyChannel: this.adhoc(this.outboundAdapter(defer.resolve)),
						errorChannel: this.adhoc(this.outboundAdapter(defer.reject))
					});

					return defer.promise;
				}.bind(this);
			},

			/**
			 * Gateway out of the messageing system to a traditional service
			 * within the application. The service may return an object, which
			 * becomes the reply message payload, or a promise to defer a reply.
			 * @param {String} [name] the name to register the activator as
			 * @param {Function} service the service to activate. Invoked with
			 * the message payload and headers as arguments.
			 * @param {String|Channel} [opts.output] the channel to recieve
			 * replies from the service
			 * @param {String|Channel} [opts.input] the channel to receive
			 * message from
			 * @param {String|Channel} [opts.error] channel to receive errors
			 * @returns the service activator handler
			 */
			serviceActivator: optionalName(function serviceActivator(name, service, opts) {
				opts = opts || {};
				return this._handler(name, function (message, reply, error) {
					when(service.call(this, message.payload, message.headers),
						function (result) {
							this.send(reply, result, message.headers);
						}.bind(this),
						function (result) {
							this.send(error, result, message.headers);
						}.bind(this)
					);
				}, opts.output, opts.input, opts.error);
			}),

			/**
			 * Channel that does nothing
			 */
			noopChannel: freeze({
				send: function () {
					return true;
				}
			}),

			/**
			 * Handler that does nothing
			 */
			noopHandler: freeze({
				handle: function () {}
			}),

			/**
			 * Common helpers that are useful to other modules but not worthy
			 * of their own module
			 */
			utils: {
				counter: counter,
				noop: function noop() { return this; },
				optionalName: optionalName
			}

		};

		// make it easy for custom extensions to the MessageBus prototype
		MessageBus.prototype.prototype = MessageBus.prototype;

		busCounter = counter();

		return new MessageBus();

	});

}(
	typeof define === 'function' ? define : function (deps, factory) {
		module.exports = factory.apply(this, deps.map(require));
	}
	// Boilerplate for AMD and Node
));
