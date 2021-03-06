//Core engine for EinZinY
"use strict";

/**
 * Load network modules.
 * @const {Module}
 */
const { https, http, net, url, ws } = global;
/**
 * Load other modules
 * @const {Module}
 */
const { agent, zlib, tls } = global;

/**
 * Get a unique ID, it will be a sequential integer.
 * @function
 * @return {integer} The unique ID.
 */
const uid = (() => {
    let counter = 0;
    return () => counter++;
})();
/**
 * Get MIME type from header.
 * @function
 * @param {string} [str=""] - The encoding related header entry.
 * @param {string} [def="text/html"] - The default value.
 * @param {boolean} [noWildcard=false] - Whether or not wildcard is allowed.
 * @return {string} A MIME type.
 */
const getType = (str = "", def = "text/html", noWildcard) => {
    let bestGuess;
    const parts = str.split(/,|;/);
    //Try to find the first precise type, assuming the header is ordered by preference
    for (let i = 0; i < parts.length; i++) {
        let entry = parts[i].trim();
        if (!bestGuess && entry === "*/*") {
            bestGuess = entry;
        } else if (entry.endsWith("/*") && (!bestGuess || bestGuess === "*/*")) {
            bestGuess = entry;
        } else if (entry.includes("/") && !entry.includes("*")) {
            //Found best entry
            bestGuess = entry;
            break;
        }
        //Not a valid MIME type otherwise
    }
    if (!bestGuess || (noWildcard && bestGuess.includes("*"))) {
        return def;
    } else {
        return bestGuess;
    }
};
/**
 * Check if given MIME type is text.
 * https://developer.mozilla.org/en-US/docs/Web/HTTP/Basics_of_HTTP/MIME_types/Complete_list_of_MIME_types
 * @function
 * @param {string} mimeType - The MIME type to check.
 * @return {boolean} True if the given MIME type is text, false otherwise.
 */
const isText = (mimeType) => {
    if (!mimeType) {
        //Assume not text
        return false;
    } else {
        return mimeType.startsWith("text/") || mimeType.endsWith("/xhtml+xml") || mimeType.endsWith("/xml");
    }
};

/**
 * Proxy engine for REQUEST request.
 * @function
 * @param {IncomingMessage} localReq - The local request object.
 * @param {ServerResponse} localRes - The local response object.
 */
let requestEngine = (localReq, localRes) => {
    global.log("INFO", `Received a REQUEST request: ${localReq.url}`);
    //Prepare request
    let options
    try {
        options = url.parse(localReq.url);
    } catch (err) {
        //Bad request
        global.log("WARNING", `Received an invalid REQUEST request: ${err.message}`);
        localRes.destroy();
        return;
    }
    //Process options
    options.method = localReq.method;
    options.headers = localReq.headers;
    options.auth = localReq.auth;
    options.agent = agent.getAgent(localReq.httpVersion, localReq.headers, options.protocol === "https:");
    //Check for host
    if (!localReq.url || localReq.url[0] === "/") {
        //Use another port if special callbacks from the web page is needed
        global.log("WARNING", "Received an invalid REQUEST request: No host give.");
        localRes.destroy();
        return;
    }
    //Only POST requests should have payloads, GET can have one but should not
    //I'll read the payload no matter what, but I'll warn the user if a GET request has a payload
    let payload = [];
    localReq.on("data", (chunk) => {
        payload.push(chunk);
    });
    localReq.on("end", () => {
        payload = Buffer.concat(payload);
        if (options.method === "GET" && payload.length) {
            global.log("WARNING", "Received a GET request with a payload.");
        }
        //Patch the request
        const id = uid();
        global.onRequest(localReq.headers["referer"], localReq.url, payload, localReq.headers, id, (decision, payload) => {
            //Further process headers so response from remote server can be parsed
            localReq.headers["accept-encoding"] = "gzip, deflate";
            switch (decision.result) {
                case global.RequestDecision.Allow:
                    //Do nothing here, process it normally
                    break;
                case global.RequestDecision.Empty:
                    localRes.writeHead(200, "OK", decision.headers || {
                        "Content-Type": getType(localReq.headers["accept"], undefined, true),
                        "Server": "Apache/2.4.7 (Ubuntu)",
                    });
                    localRes.end();
                    return; //Stop here
                case global.RequestDecision.Deny:
                    localRes.destroy();
                    return; //Stop here
                case global.RequestDecision.Redirect:
                    if (decision.redirectLocation === null) {
                        //Just write back the redirected text
                        localRes.writeHead(200, "OK", decision.headers || {
                            "Content-Type": getType(localReq.headers["accept"], undefined, true),
                            "Server": "Apache/2.4.7 (Ubuntu)",
                        });
                        localRes.write(decision.redirectText);
                        localRes.end();
                        return;
                    } else {
                        //I expect the patcher to return valid URL
                        Object.assign(options, url.parse(decision.redirectLocation));
                        break;
                    }
                default:
                    throw new Error(`requestEngine() does not accept ${decision} as a request decision.`);
            }
            //Proxy request
            let request = (options.protocol === "https:" ? https : http).request(options, (remoteRes) => {
                //remoteRes is http.IncomingMessage, which is also a Stream
                let data = [];
                remoteRes.on("data", (chunk) => {
                    data.push(chunk);
                });
                remoteRes.on("end", () => {
                    data = Buffer.concat(data);
                    //Check content type, I can only patch text
                    //I'm still able to change the header of non-text response though
                    //I can also completely replace the content no matter what it is, but that should be done by request patcher
                    if (isText(getType(remoteRes.headers["content-type"]))) {
                        //Check encoding
                        let encoding = remoteRes.headers["content-encoding"];
                        if (encoding) {
                            encoding = encoding.toLowerCase();
                        }
                        //So I don't need to encode it again
                        //Response patcher can encode it again and change this header if needed
                        remoteRes.headers["content-encoding"] = "identity";
                        if (encoding === "gzip" || encoding === "deflate") {
                            zlib.unzip(data, (err, result) => {
                                if (err) {
                                    //Could not parse
                                    global.log("WARNING", `Could not parse server response: ${err.message}`);
                                    localRes.destroy();
                                } else {
                                    requestEngine.finalize(localRes, remoteRes, localReq.headers["referer"], localReq.url, true, result, id);
                                }
                            });
                        } else {
                            //Assume identity
                            requestEngine.finalize(localRes, remoteRes, localReq.headers["referer"], localReq.url, true, data, id);
                        }
                    } else {
                        //Not text
                        requestEngine.finalize(localRes, remoteRes, localReq.headers["referer"], localReq.url, false, data, id);
                    }
                });
                remoteRes.on("error", (err) => {
                    //Something went wrong
                    global.log("WARNING", `Could not connect to remote server: ${err.message}`);
                    localRes.destroy();
                });
                remoteRes.on("aborted", () => {
                    //Remote server disconnected prematurely, drop the local connection
                    localRes.destroy();
                });
            });
            request.on("error", (err) => {
                global.log("WARNING", `Could not connect to remote server: ${err.message}`);
                localRes.destroy();
            });
            //Forward on patched POST payload
            request.write(payload);
            request.end();
            //Abort request when local client disconnects
            localReq.on("aborted", () => { request.abort(); });
        });
    });
    localReq.on("error", (err) => {
        global.log("WARNING", `Local connection failed: ${err.message}`);
        localRes.destroy();
    });
};
/**
 * Process final request result of a REQUEST request and send it to client.
 * @function
 * @param {http.ServerResponse} localRes - The object that can be used to respond client request.
 * @param {http.IncomingMessage} remoteRes - The object that contains data about server response.
 * @param {string} referer - The referrer, if exist.
 * @param {string} url - The request URL.
 * @param {boolean} isText - Whether the response data is text.
 * @param {Any} responseData - The response data.
 * @param {integer} id - The unique ID of the request.
 */
requestEngine.finalize = (localRes, remoteRes, referer, url, isText, responseData, id) => {
    const onDone = () => {
        //Update content length
        remoteRes.headers["content-length"] = Buffer.byteLength(responseData);
        //Prevent public key pinning
        delete remoteRes.headers["Public-Key-Pins"];
        //Send response to user agent
        localRes.writeHead(remoteRes.statusCode, remoteRes.statusMessage, remoteRes.headers);
        localRes.write(responseData);
        localRes.end();
    };
    if (isText) {
        global.onTextResponse(referer, url, responseData.toString(), remoteRes.headers, id, (patchedData) => {
            responseData = patchedData;
            onDone();
        });
    } else {
        global.onOtherResponse(referer, url, responseData, remoteRes.headers, id, (patchedData) => {
            responseData = patchedData;
            onDone();
        });
    }
};

/**
 * The dynamic server, clients that support Sever Name Indication will be routed to this server.
 * This server will be initialized when exports.start() is called.
 * @const {DynamicServer}
 */
let dynamicServer;
/**
 * Dynamic server class.
 * @class
 */
const DynamicServer = class {
    /**
     * The constructor for SNI server.
     * @constructor
     */
    constructor() {
        //The port of this server
        this.port = 12346;
        //The host where I have certificate for
        this.knownHosts = [];
        //Initialize server
        this.server = https.createServer({});
        //Handle error
        this.server.on("error", (err) => {
            global.log("ERROR", `An error occured on the dynamic server.`);
            throw err;
        });
        this.server.on("clientError", (err, localSocket) => {
            global.log("WARNING", `A client error occured on the dynamic server: ${err.message}`)
            localSocket.destroy();
        });
        //Bind event handlers
        this.server.on("request", this.onRequest);
        this.webSocketServer = new ws.Server({ server: this.server });
        this.webSocketServer.on("connection", onWebSocketEngine);
        this.server.listen(this.port);
    }
    /**
     * Schedule a function to call once the server is ready to handle the request.
     * @method
     * @param {string} host - The host to connect to.
     * @param {Function} func - The function to call when the server is ready.
     ** @param {integer} localPort - The local port matching the given remote port.
     */
    prepare(host, callback) {
        //Check if I have the certificate for the host
        if (this.knownHosts.includes(host)) {
            process.nextTick(() => {
                callback();
            });
        } else {
            tls.sign(host, (cert) => {
                this.knownHosts.push(host);
                this.server.addContext(host, cert);
                callback();
            });
        }
    }
    /**
     * Dynamic server REQUEST request handler, slightly modify the URL and send it off to the main REQUEST request handler.
     * @method
     * @param {IncomingMessage} localReq - The local request object.
     * @param {ServerResponse} localRes - The local response object.
     */
    onRequest(localReq, localRes) {
        //Fill in the full URL and send off to request engine
        localReq.url = "https://" + localReq.headers["host"] + localReq.url;
        requestEngine(localReq, localRes);
    }
};
/**
 * Proxy engine for CONNECT requests.
 * @function
 * @param {IncomingMessage} localReq - The local request object.
 * @param {Socket} localSocket - The local socket, the user agent will ask me to connect this to a socket of the remote server.
 * @param {Buffer} localHead - The begining of message, this may or may not be present.
 */
let connectEngine = (() => {
    //Precompile RegExp
    const isInteger = /^\d+$/;
    //Return clusure function
    return (localReq, localSocket, localHead) => {
        global.log("INFO", `Received a CONNECT request: ${localReq.url}`);
        //Parse request, expects something like example.com:443, but need to take in account of IPv6
        let parts = localReq.url.split(":");
        let port = 443;
        if (isInteger.test(parts[parts.length - 1])) {
            //Last part is all digits, it's a port number
            port = parseInt(parts.pop());
            if (port < 0 || port > 65535) {
                port = 443;
            }
        }
        //The rest is host
        const host = parts.join(":");
        localSocket.pause();
        //See what I need to do
        const id = uid();
        global.onConnect(`${host}:${port}`, id, (decision) => {
            switch (decision.result) {
                case global.RequestDecision.Allow:
                    //Do nothing here, process it normally
                    break;
                case global.RequestDecision.Deny:
                    localSocket.destroy();
                    return; //Stop here
                case global.RequestDecision.Pipe:
                    const connection = net.connect(port, host, () => {
                        //Pipe the connection over to the server
                        localSocket.pipe(connection);
                        connection.pipe(localSocket);
                        //Send the head that I got before over
                        localSocket.emit("data", localHead);
                        //Resume the socket that I paused before
                        localSocket.resume();
                    });
                    return; //Stop here
                default:
                    throw new Error(`connectEngine() does not accept ${decision} as a request decision.`);
            }
            //Since SSLv2 is now prohibited and Chromium is already rejecting SSLv3 connections, in 2017, I can safely assume only TLS is used
            //https://tools.ietf.org/html/rfc6176
            //I need 3 bytes of data to distinguish a TLS handshake from plain text
            if (localHead && localHead.length >= 3) {
                connectEngine.onHandshake(localReq, localSocket, localHead, host, port);
            } else {
                let data = localHead;
                const handler = () => {
                    localSocket.once("data", (incomingData) => {
                        data = Buffer.concat([data, incomingData]);
                        if (data.length < 3) {
                            handler();
                        } else {
                            localSocket.pause();
                            connectEngine.onHandshake(localReq, localSocket, data, host, port);
                        }
                    });
                };
                handler();
                //Now I need to tell the user agent to send over the data
                //Line break is \r\n regardless of platform
                //https://stackoverflow.com/questions/5757290/http-header-line-break-style
                localSocket.write(`HTTP/${localReq.httpVersion} 200 Connection Established\r\n`); //Maybe I should hard code this as HTTP/1.1
                if (localReq.headers["connection"] === "keep-alive") {
                    localSocket.write("Connection: keep-alive\r\n");
                }
                if (localReq.headers["proxy-connection"] === "keep-alive") {
                    localSocket.write("Proxy-Connection: keep-alive\r\n");
                }
                //Write an emply line to signal the user agent that HTTP header has ended
                localSocket.write("\r\n");
                //Resume the socket so I can receive the handshake
                localSocket.resume();
            }
        });
    };
})();
/**
 * Detect TLS handshake from incoming data.
 * http://blog.bjrn.se/2012/07/fun-with-tls-handshake.html
 * https://tools.ietf.org/html/rfc5246
 * https://github.com/openssl/openssl/blob/a9c85ceaca37b6b4d7e4c0c13c4b75a95561c2f6/include/openssl/tls1.h#L65
 * The first 2 bytes should be 0x16 0x03, and the 3rd byte should be 0x01, 0x02, 0x03, or 0x04.
 * https://github.com/mitmproxy/mitmproxy/blob/ee6ea31147428729776ea2e8fe24d1fc44c63c9b/mitmproxy/proxy/protocol/tls.py
 * @function
 * @param {IncomingMessage} localReq - The local request object.
 * @param {Socket} localSocket - The local socket object.
 * @param {Buffer} localHead - The begining of message, there must be at least 3 bytes.
 * @param {string} host - The remote host to connect to.
 * @param {integer} port - The remote port to connect to.
 */
connectEngine.onHandshake = (localReq, localSocket, localHead, host, port) => {
    //Check if the connection is TLS
    const firstBytes = [localHead.readUInt8(0), localHead.readUInt8(1), localHead.readUInt8(2)];
    if (firstBytes[0] === 0x16 && firstBytes[1] === 0x03 && firstBytes[2] < 0x06) { //Testing for smaller than or equal to 0x05 just in case
        //Assuming all connection accepts SNI
        dynamicServer.prepare(host, () => {
            const connection = net.connect(dynamicServer.port, () => {
                //Pipe the connection over to the server
                localSocket.pipe(connection);
                connection.pipe(localSocket);
                //Send the head that I got before over
                localSocket.emit("data", localHead);
                //Resume the socket that I paused before
                localSocket.resume();
            });
            connection.on("error", (err) => {
                global.log("ERROR", `An error occured when connecting to dynamic server for encrypted requests handling.`);
                throw err;
            });
        });
    } else {
        //Assume to be WebSocket, forward to the main proxy server itself
        const connection = net.connect(12345, () => {
            //Pipe the connection over to the server
            localSocket.pipe(connection);
            connection.pipe(localSocket);
            //Send the head that I got before over
            localSocket.emit("data", localHead);
            //Resume the socket that I paused before
            localSocket.resume();
        });
        connection.on("error", (err) => {
            global.log("ERROR", `An error occured when backlooping for WebSocket handling.`);
            throw err;
        });
    }
};

/**
 * Proxy engine for WebSocket.
 * @function
 * @param {boolean} isTLS - Whether or not TLS is used, since this event handler handles both
 * @param {WebSocket} localSocket - The WebSocket socket from local user agent.
 */
const onWebSocketEngine = (isTLS, localSocket) => {

};

/**
 * Start a proxy server.
 * @function
 * @param {Object} config - The configuration object.
 ** {boolean} [useTLS=false] - Whether the proxy server should be started in HTTPS mode.
 */
exports.start = (useTLS = false) => {
    let server;
    const onDone = () => {
        //Initialize SNI server
        dynamicServer = new DynamicServer();
        //Listen to REQUEST requests
        server.on("request", requestEngine);
        //Listen to CONNECT requests
        server.on("connect", connectEngine);
        //Listen to WebSocket requests
        const webSocketServer = new ws.Server({ server: server });
        webSocketServer.on("connection", onWebSocketEngine);
        //Handle errors
        server.on("error", (err) => {
            global.log("ERROR", `An error occured on the main proxy server.`);
            throw err;
        });
        server.on("clientError", (err, socket) => {
            global.log("WARNING", `A client error occurred on the main proxy server: ${err.message}`);
            socket.destroy();
        });
        //Listen to the port
        server.listen(12345);
    };
    //Check TLS configuration and create the right server
    if (useTLS) {
        global.log("INFO", "Loading certificate authority root certificate...");
        tls.init(() => {
            server = https.createServer(global.localCert); //Still handle REQUEST the same way
            global.log("INFO", `EinZinY started on port 12345, encryption is enabled.`);
            onDone();
        });
    } else {
        //Similar to the mode above, except the proxy server itself is started in HTTP mode
        //This is good for localhost, as it would speed up the proxy server
        global.log("INFO", "Loading certificate authority root certificate...");
        tls.init(() => {
            server = http.createServer();
            global.log("INFO", `EinZinY started on port 12345, encryption is disabled.`);
            global.log("WARNING", "The connection between your user agent and EinZinY is not encrypted.");
            onDone();
        });
    }
};

//Handle server crash
process.on("uncaughtException", (err) => {
    global.log("ERROR", "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    global.log("ERROR", "!!!!! EinZinY encountered a fatal error and is about to crash !!!!!");
    global.log("ERROR", "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    global.log("ERROR", "If you believe this is caused by a bug, please inform us at https://github.com/EinZinY/Core/issues");
    throw err;
});
