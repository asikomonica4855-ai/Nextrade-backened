const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 10000;

const DERIV_CLIENT_ID =
    process.env.DERIV_CLIENT_ID;

const BACKEND_URL =
    "https://nextrade-backened.onrender.com";

const FRONTEND_URL =
    "https://asikomonica4855-ai.github.io/Nextrade";

const DERIV_REDIRECT_URI =
    process.env.DERIV_REDIRECT_URI ||
    `${BACKEND_URL}/oauth/callback`;

const sessions = new Map();
const oauthStates = new Map();

/* =========================
   HELPERS
========================= */

function cors(res) {
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

function json(res, status, data) {
    cors(res);

    res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
    });

    res.end(JSON.stringify(data));
}

function redirect(res, url) {
    cors(res);

    res.writeHead(302, {
        Location: url,
        "Cache-Control": "no-store"
    });

    res.end();
}

function frontend(path) {
    return FRONTEND_URL + path;
}

function state() {
    return crypto
        .randomBytes(32)
        .toString("hex");
}

function verifier() {
    return crypto
        .randomBytes(64)
        .toString("base64url")
        .slice(0, 128);
}

function challenge(v) {
    return crypto
        .createHash("sha256")
        .update(v)
        .digest("base64url");
}

function sessionId() {
    return crypto
        .randomBytes(48)
        .toString("base64url");
}

/* =========================
   COOKIES
========================= */

function cookies(req) {
    const result = {};
    const header = req.headers.cookie || "";

    header.split(";").forEach(part => {
        const i = part.indexOf("=");

        if (i === -1) return;

        const key =
            part.slice(0, i).trim();

        const value =
            part.slice(i + 1).trim();

        result[key] =
            decodeURIComponent(value);
    });

    return result;
}

function getSession(req) {
    const c = cookies(req);

    const id =
        c.nextrade_session;

    if (!id) return null;

    const session =
        sessions.get(id);

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

function setCookie(res, id) {
    res.setHeader(
        "Set-Cookie",
        [
            `nextrade_session=${encodeURIComponent(id)}`,
            "HttpOnly",
            "Secure",
            "SameSite=None",
            "Path=/",
            "Max-Age=604800"
        ].join("; ")
    );
}

function clearCookie(res) {
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

/* =========================
   SERVER
========================= */

const server =
    http.createServer(
        async (req, res) => {

            cors(res);

            const url =
                new URL(
                    req.url,
                    `http://${req.headers.host || "localhost"}`
                );

            const path =
                url.pathname;

            /* OPTIONS */

            if (req.method === "OPTIONS") {
                res.writeHead(204);
                res.end();
                return;
            }

            /* ROOT */

            if (
                req.method === "GET" &&
                path === "/"
            ) {
                json(res, 200, {
                    service:
                        "MUKHU Backend",

                    status:
                        "online",

                    authentication:
                        Boolean(DERIV_CLIENT_ID),

                    marketData:
                        "frontend-public-websocket",

                    frontend:
                        FRONTEND_URL
                });

                return;
            }

            /* HEALTH */

            if (
                req.method === "GET" &&
                path === "/health"
            ) {
                json(res, 200, {
                    status: "ok",
                    authentication:
                        Boolean(DERIV_CLIENT_ID),
                    timestamp:
                        Date.now()
                });

                return;
            }

            /* STATUS */

            if (
                req.method === "GET" &&
                path === "/api/status"
            ) {
                json(res, 200, {
                    success: true,

                    backend: "online",

                    authentication:
                        Boolean(DERIV_CLIENT_ID),

                    marketData:
                        "PUBLIC_DIRECT",

                    websocket:
                        "wss://ws.binaryws.com/websockets/v3"
                });

                return;
            }

            /* SESSION */

            if (
                req.method === "GET" &&
                path === "/api/session"
            ) {
                const session =
                    getSession(req);

                json(res, 200, {
                    authenticated:
                        Boolean(session),

                    user:
                        session?.data?.user ||
                        null
                });

                return;
            }

            /* ACCOUNTS */

            if (
                req.method === "GET" &&
                path === "/api/accounts"
            ) {
                const session =
                    getSession(req);

                if (!session) {
                    json(res, 401, {
                        success: false,
                        error:
                            "Not authenticated"
                    });

                    return;
                }

                json(res, 200, {
                    success: true,

                    accounts:
                        session.data.accounts ||
                        []
                });

                return;
            }

            /* OAUTH STATUS */

            if (
                req.method === "GET" &&
                path === "/oauth/status"
            ) {
                json(res, 200, {
                    oauthConfigured:
                        Boolean(DERIV_CLIENT_ID),

                    redirectUri:
                        DERIV_REDIRECT_URI
                });

                return;
            }

            /* OAUTH START */

            if (
                req.method === "GET" &&
                path === "/oauth/authorize"
            ) {

                if (!DERIV_CLIENT_ID) {
                    json(res, 500, {
                        success: false,
                        error:
                            "DERIV_CLIENT_ID is not configured on Render."
                    });

                    return;
                }

                const v =
                    verifier();

                const s =
                    state();

                oauthStates.set(
                    s,
                    {
                        verifier: v,
                        createdAt: Date.now()
                    }
                );

                const params =
                    new URLSearchParams();

                params.set(
                    "response_type",
                    "code"
                );

                params.set(
                    "client_id",
                    DERIV_CLIENT_ID
                );

                params.set(
                    "redirect_uri",
                    DERIV_REDIRECT_URI
                );

                params.set(
                    "scope",
                    "trade"
                );

                params.set(
                    "state",
                    s
                );

                params.set(
                    "code_challenge",
                    challenge(v)
                );

                params.set(
                    "code_challenge_method",
                    "S256"
                );

                redirect(
                    res,
                    "https://auth.deriv.com/oauth2/auth?" +
                    params.toString()
                );

                return;
            }

            /* OAUTH CALLBACK */

            if (
                req.method === "GET" &&
                path === "/oauth/callback"
            ) {

                const code =
                    url.searchParams.get(
                        "code"
                    );

                const s =
                    url.searchParams.get(
                        "state"
                    );

                const error =
                    url.searchParams.get(
                        "error"
                    );

                if (error) {
                    redirect(
                        res,
                        frontend(
                            "/login.html?oauth_error=" +
                            encodeURIComponent(error)
                        )
                    );

                    return;
                }

                if (!code || !s) {
                    json(res, 400, {
                        success: false,
                        error:
                            "Missing OAuth code or state."
                    });

                    return;
                }

                const oauth =
                    oauthStates.get(s);

                if (!oauth) {
                    json(res, 400, {
                        success: false,
                        error:
                            "Invalid or expired OAuth state."
                    });

                    return;
                }

                oauthStates.delete(s);

                try {

                    const tokenResponse =
                        await fetch(
                            "https://auth.deriv.com/oauth2/token",
                            {
                                method: "POST",

                                headers: {
                                    "Content-Type":
                                        "application/x-www-form-urlencoded"
                                },

                                body:
                                    new URLSearchParams({
                                        grant_type:
                                            "authorization_code",

                                        client_id:
                                            DERIV_CLIENT_ID,

                                        code,

                                        code_verifier:
                                            oauth.verifier,

                                        redirect_uri:
                                            DERIV_REDIRECT_URI
                                    })
                            }
                        );

                    const token =
                        await tokenResponse.json();

                    if (
                        !tokenResponse.ok ||
                        token.error ||
                        !token.access_token
                    ) {
                        console.error(
                            "OAuth token error:",
                            token
                        );

                        redirect(
                            res,
                            frontend(
                                "/login.html?oauth_error=token_exchange_failed"
                            )
                        );

                        return;
                    }

                    const accessToken =
                        token.access_token;

                    /*
                     * We keep the OAuth token
                     * securely on the backend.
                     *
                     * Account information can be
                     * added through the authenticated
                     * Deriv API later.
                     */

                    const id =
                        sessionId();

                    sessions.set(
                        id,
                        {
                            accessToken,

                            accounts: [],

                            user: {
                                connected:
                                    true
                            },

                            createdAt:
                                Date.now(),

                            expiresAt:
                                Date.now() +
                                7 *
                                24 *
                                60 *
                                60 *
                                1000
                        }
                    );

                    setCookie(
                        res,
                        id
                    );

                    console.log(
                        "OAuth login successful."
                    );

                    redirect(
                        res,
                        frontend(
                            "/markets.html"
                        )
                    );

                    return;

                } catch (err) {

                    console.error(
                        "OAuth callback error:",
                        err
                    );

                    redirect(
                        res,
                        frontend(
                            "/login.html?oauth_error=callback_failed"
                        )
                    );

                    return;
                }
            }

            /* LOGOUT */

            if (
                req.method === "POST" &&
                path === "/api/logout"
            ) {

                const session =
                    getSession(req);

                if (session) {
                    sessions.delete(
                        session.id
                    );
                }

                clearCookie(res);

                json(res, 200, {
                    success: true
                });

                return;
            }

            /* 404 */

            json(res, 404, {
                success: false,
                error: "Not found",
                path
            });
        }
    );

/* =========================
   START
========================= */

server.listen(
    PORT,
    () => {

        console.log(
            "================================"
        );

        console.log(
            "MUKHU BACKEND ONLINE"
        );

        console.log(
            "================================"
        );

        console.log(
            "Port:",
            PORT
        );

        console.log(
            "Frontend:",
            FRONTEND_URL
        );

        console.log(
            "OAuth:",
            Boolean(DERIV_CLIENT_ID)
        );

        console.log(
            "Market data:",
            "DIRECT PUBLIC WEBSOCKET"
        );

        console.log(
            "================================"
        );
    }
);

process.on(
    "uncaughtException",
    error => {
        console.error(
            "UNCAUGHT:",
            error
        );
    }
);

process.on(
    "unhandledRejection",
    error => {
        console.error(
            "UNHANDLED:",
            error
        );
    }
);
