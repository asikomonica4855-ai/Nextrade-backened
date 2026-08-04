const http = require("http");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const DERIV_CLIENT_ID =
    process.env.DERIV_CLIENT_ID || "";

const BACKEND_URL =
    "https://nextrade-backened.onrender.com";

const FRONTEND_URL =
    "https://asikomonica4855-ai.github.io/Nextrade";

const DERIV_REDIRECT_URI =
    process.env.DERIV_REDIRECT_URI ||
    `${BACKEND_URL}/oauth/callback`;

/* FIXED */
const DERIV_WS_URL =
    `wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(
        DERIV_CLIENT_ID
    )}`;

const SYMBOLS = [
    "1HZ100V",
    "1HZ75V",
    "1HZ50V",
    "1HZ25V",
    "1HZ10V",
    "R_100",
    "R_75",
    "R_50",
    "R_25",
    "R_10"
];

let derivSocket = null;
let derivConnected = false;

const clients = new Set();
const oauthStates = new Map();
const sessions = new Map();

/* ==================================================
   HELPERS
================================================== */

function setCors(res) {
    res.setHeader(
        "Access-Control-Allow-Origin",
        FRONTEND_URL
    );

    res.setHeader(
        "Access-Control-Allow-Credentials",
        "true"
    );

    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET,POST,OPTIONS"
    );

    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization"
    );
}

function sendJson(res, status, data) {
    setCors(res);

    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
    });

    res.end(JSON.stringify(data));
}

function redirect(res, url) {
    setCors(res);

    res.writeHead(302, {
        Location: url,
        "Cache-Control": "no-store"
    });

    res.end();
}

function frontend(path) {
    return FRONTEND_URL + path;
}

function createState() {
    return crypto.randomBytes(32).toString("hex");
}

function createVerifier() {
    return crypto
        .randomBytes(64)
        .toString("base64url")
        .slice(0, 128);
}

function createChallenge(verifier) {
    return crypto
        .createHash("sha256")
        .update(verifier)
        .digest("base64url");
}

function createSessionId() {
    return crypto
        .randomBytes(48)
        .toString("base64url");
}

/* ==================================================
   COOKIES / SESSIONS
================================================== */

function getCookies(req) {
    const result = {};
    const header = req.headers.cookie || "";

    header.split(";").forEach(part => {
        const index = part.indexOf("=");

        if (index === -1) return;

        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();

        try {
            result[key] = decodeURIComponent(value);
        } catch {
            result[key] = value;
        }
    });

    return result;
}

function getSession(req) {
    const cookies = getCookies(req);
    const id = cookies.nextrade_session;

    if (!id) return null;

    const session = sessions.get(id);

    if (!session) return null;

    if (
        session.expiresAt &&
        Date.now() > session.expiresAt
    ) {
        sessions.delete(id);
        return null;
    }

    return {
        id,
        data: session
    };
}

function setSessionCookie(res, sessionId) {
    res.setHeader(
        "Set-Cookie",
        [
            `nextrade_session=${encodeURIComponent(sessionId)}`,
            "HttpOnly",
            "Secure",
            "SameSite=None",
            "Path=/",
            "Max-Age=604800"
        ].join("; ")
    );
}

function clearSessionCookie(res) {
    res.setHeader(
        "Set-Cookie",
        [
            "nextrade_session=",
            "HttpOnly",
            "Secure",
            "SameSite=None",
            "Path=/",
            "Max-Age=0"
        ].join("; ")
    );
}

/* ==================================================
   PUBLIC MARKET DATA
================================================== */

function broadcast(data) {
    const message = JSON.stringify(data);

    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(message);
            } catch {}
        }
    }
}

function connectDeriv() {
    if (derivSocket) {
        try {
            derivSocket.close();
        } catch {}
    }

    if (!DERIV_CLIENT_ID) {
        console.error(
            "DERIV_CLIENT_ID is missing."
        );

        derivConnected = false;

        broadcast({
            type: "status",
            connected: false
        });

        setTimeout(connectDeriv, 10000);

        return;
    }

    console.log(
        "Connecting to public market data..."
    );

    derivSocket = new WebSocket(
        DERIV_WS_URL
    );

    derivSocket.on("open", () => {
        derivConnected = true;

        console.log(
            "Public market WebSocket connected"
        );

        broadcast({
            type: "status",
            connected: true
        });

        for (const symbol of SYMBOLS) {
            try {
                derivSocket.send(
                    JSON.stringify({
                        ticks: symbol,
                        subscribe: 1
                    })
                );
            } catch (error) {
                console.error(
                    "Subscription error:",
                    error.message
                );
            }
        }
    });

    derivSocket.on("message", raw => {
        try {
            const data = JSON.parse(
                raw.toString()
            );

            if (
                data.msg_type === "tick" &&
                data.tick
            ) {
                const price =
                    Number(data.tick.quote);

                if (
                    data.tick.symbol &&
                    Number.isFinite(price)
                ) {
                    broadcast({
                        type: "tick",

                        data: {
                            symbol:
                                data.tick.symbol,

                            price,

                            epoch:
                                data.tick.epoch
                        }
                    });
                }
            }

            if (data.error) {
                console.error(
                    "Market data error:",
                    data.error
                );

                broadcast({
                    type: "deriv_error",
                    error: data.error
                });
            }

        } catch (error) {
            console.error(
                "Market message error:",
                error.message
            );
        }
    });

    derivSocket.on("close", () => {
        derivConnected = false;

        console.log(
            "Public market WebSocket closed"
        );

        broadcast({
            type: "status",
            connected: false
        });

        setTimeout(
            connectDeriv,
            5000
        );
    });

    derivSocket.on("error", error => {
        derivConnected = false;

        console.error(
            "Deriv public WebSocket error:",
            error.message
        );
    });
}

/* ==================================================
   HTTP SERVER
================================================== */

const server = http.createServer(
    async (req, res) => {

        setCors(res);

        const parsed = new URL(
            req.url,
            `http://${req.headers.host || "localhost"}`
        );

        const pathname = parsed.pathname;

        /* OPTIONS */

        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }

        /* ROOT */

        if (
            req.method === "GET" &&
            pathname === "/"
        ) {
            sendJson(res, 200, {
                service: "MUKHU Backend",
                status: "online",
                backend: BACKEND_URL,
                frontend: FRONTEND_URL,
                derivConnected,
                oauthConfigured:
                    Boolean(DERIV_CLIENT_ID),
                markets: SYMBOLS.length,
                websocket: "available"
            });

            return;
        }

        /* HEALTH */

        if (
            req.method === "GET" &&
            pathname === "/health"
        ) {
            sendJson(res, 200, {
                status: "ok",
                derivConnected,
                oauthConfigured:
                    Boolean(DERIV_CLIENT_ID),
                markets: SYMBOLS.length,
                timestamp: Date.now()
            });

            return;
        }

        /* STATUS */

        if (
            req.method === "GET" &&
            pathname === "/api/status"
        ) {
            sendJson(res, 200, {
                success: true,
                backend: "online",
                derivConnected,
                oauthConfigured:
                    Boolean(DERIV_CLIENT_ID),
                symbols: SYMBOLS
            });

            return;
        }

        /* SESSION */

        if (
            req.method === "GET" &&
            pathname === "/api/session"
        ) {
            const session = getSession(req);

            sendJson(res, 200, {
                authenticated:
                    Boolean(session),

                user:
                    session?.data?.user || null
            });

            return;
        }

        /* ACCOUNTS */

        if (
            req.method === "GET" &&
            pathname === "/api/accounts"
        ) {
            const session = getSession(req);

            if (!session) {
                sendJson(res, 401, {
                    success: false,
                    error: "Not authenticated"
                });

                return;
            }

            sendJson(res, 200, {
                success: true,

                accounts:
                    session.data.accounts || []
            });

            return;
        }

        /* OAUTH STATUS */

        if (
            req.method === "GET" &&
            pathname === "/oauth/status"
        ) {
            sendJson(res, 200, {
                oauthConfigured:
                    Boolean(DERIV_CLIENT_ID),

                redirectUri:
                    DERIV_REDIRECT_URI
            });

            return;
        }

        /* OAUTH AUTHORIZE */

        if (
            req.method === "GET" &&
            pathname === "/oauth/authorize"
        ) {
            if (!DERIV_CLIENT_ID) {
                sendJson(res, 500, {
                    success:
