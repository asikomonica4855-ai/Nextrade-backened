const http = require("http");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const DERIV_CLIENT_ID = process.env.DERIV_CLIENT_ID;

const BACKEND_URL =
"https://nextrade-backened.onrender.com";

const FRONTEND_URL =
"https://asikomonica4855-ai.github.io/Nextrade";

const DERIV_REDIRECT_URI =
process.env.DERIV_REDIRECT_URI ||
"${BACKEND_URL}/oauth/callback";

const DERIV_WS_URL =
"wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent( DERIV_CLIENT_ID || "" )}";

/* ==================================================
MUKHU MARKET SYMBOLS
================================================== */

const SYMBOLS = [

// VOLATILITY
"1HZ100V",
"1HZ75V",
"1HZ50V",
"1HZ25V",
"1HZ10V",
"R_100",
"R_75",
"R_50",
"R_25",
"R_10",

// FOREX
"frxEURUSD",
"frxGBPUSD",
"frxUSDJPY",
"frxAUDUSD",
"frxUSDCAD",
"frxUSDCHF",

// CRYPTO
"cryBTCUSD",
"cryETHUSD",

// INDICES
"US_30",
"US_500",
"NAS100",

// COMMODITIES
"frxXAUUSD",
"frxXAGUSD"

];

/* ==================================================
STATE
================================================== */

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
    "Content-Type":
        "application/json; charset=utf-8",

    "Cache-Control":
        "no-store"
});

res.end(
    JSON.stringify(data)
);

}

function redirect(res, url) {

setCors(res);

res.writeHead(302, {
    Location: url,
    "Cache-Control":
        "no-store"
});

res.end();

}

function frontend(path) {
return FRONTEND_URL + path;
}

function createState() {

return crypto
    .randomBytes(32)
    .toString("hex");

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
COOKIES
================================================== */

function getCookies(req) {

const result = {};

const header =
    req.headers.cookie || "";

header
    .split(";")
    .forEach(part => {

        const index =
            part.indexOf("=");

        if(index === -1)
            return;

        const key =
            part
                .slice(0, index)
                .trim();

        const value =
            part
                .slice(index + 1)
                .trim();

        try {

            result[key] =
                decodeURIComponent(value);

        } catch {

            result[key] = value;

        }

    });

return result;

}

function getSession(req) {

const cookies =
    getCookies(req);

const id =
    cookies.nextrade_session;

if(!id)
    return null;

const session =
    sessions.get(id);

if(!session)
    return null;

if(
    session.expiresAt &&
    Date.now() >
    session.expiresAt
){

    sessions.delete(id);

    return null;
}

return {
    id,
    data: session
};

}

function setSessionCookie(
res,
sessionId
){

res.setHeader(
    "Set-Cookie",
    [
        `nextrade_session=${encodeURIComponent(
            sessionId
        )}`,
        "HttpOnly",
        "Secure",
        "SameSite=None",
        "Path=/",
        "Max-Age=604800"
    ].join("; ")
);

}

function clearSessionCookie(res){

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
BROADCAST
================================================== */

function broadcast(data){

const message =
    JSON.stringify(data);

for(
    const client of clients
){

    if(
        client.readyState ===
        WebSocket.OPEN
    ){

        try {

            client.send(message);

        } catch {}

    }

}

}

/* ==================================================
DERIV LIVE MARKET CONNECTION
================================================== */

function connectDeriv(){

if(derivSocket){

    try {
        derivSocket.close();
    } catch {}

}

if(!DERIV_CLIENT_ID){

    console.error(
        "DERIV_CLIENT_ID is missing."
    );

    derivConnected = false;

    broadcast({
        type:"status",
        connected:false,
        error:"DERIV_CLIENT_ID missing"
    });

    setTimeout(
        connectDeriv,
        10000
    );

    return;
}

console.log(
    "Connecting to Deriv market data..."
);

derivSocket =
    new WebSocket(
        DERIV_WS_URL
    );

derivSocket.on(
    "open",
    () => {

        derivConnected = true;

        console.log(
            "Deriv WebSocket connected"
        );

        broadcast({
            type:"status",
            connected:true
        });

        /*
         * Subscribe to every configured
         * market individually.
         */

        SYMBOLS.forEach(
            symbol => {

                try {

                    derivSocket.send(
                        JSON.stringify({
                            ticks:symbol,
                            subscribe:1
                        })
                    );

                } catch(error){

                    console.error(
                        "Subscription error:",
                        symbol,
                        error.message
                    );

                }

            }
        );

    }
);

derivSocket.on(
    "message",
    raw => {

        try {

            const data =
                JSON.parse(
                    raw.toString()
                );

            /* TICK */

            if(
                data.msg_type === "tick" &&
                data.tick
            ){

                const price =
                    Number(
                        data.tick.quote
                    );

                if(
                    Number.isFinite(price)
                ){

                    broadcast({
                        type:"tick",

                        data:{
                            symbol:
                                data.tick.symbol,

                            price,

                            epoch:
                                data.tick.epoch
                        }
                    });

                }

                return;
            }

            /* DERIV ERROR */

            if(data.error){

                console.error(
                    "Market error:",
                    data.error.message ||
                    data.error.code ||
                    data.error
                );

                broadcast({
                    type:"deriv_error",

                    error:{
                        code:
                            data.error.code,

                        message:
                            data.error.message,

                        details:
                            data.error.details
                    }
                });

            }

        } catch(error){

            console.error(
                "Deriv message error:",
                error.message
            );

        }

    }
);

derivSocket.on(
    "close",
    () => {

        derivConnected = false;

        console.log(
            "Deriv WebSocket closed"
        );

        broadcast({
            type:"status",
            connected:false
        });

        setTimeout(
            connectDeriv,
            5000
        );

    }
);

derivSocket.on(
    "error",
    error => {

        derivConnected = false;

        console.error(
            "Deriv WebSocket error:",
            error.message
        );

    }
);

}

/* ==================================================
HTTP SERVER
================================================== */

const server =
http.createServer(
async(req,res) => {

        setCors(res);

        const parsed =
            new URL(
                req.url,
                `http://${
                    req.headers.host ||
                    "localhost"
                }`
            );

        const pathname =
            parsed.pathname;

        /* OPTIONS */

        if(
            req.method ===
            "OPTIONS"
        ){

            res.writeHead(204);

            res.end();

            return;
        }

        /* ROOT */

        if(
            req.method === "GET" &&
            pathname === "/"
        ){

            sendJson(
                res,
                200,
                {
                    service:
                        "MUKHU Backend",

                    status:
                        "online",

                    backend:
                        BACKEND_URL,

                    frontend:
                        FRONTEND_URL,

                    derivConnected,

                    oauthConfigured:
                        Boolean(
                            DERIV_CLIENT_ID
                        ),

                    markets:
                        SYMBOLS.length,

                    websocket:
                        "available"
                }
            );

            return;
        }

        /* HEALTH */

        if(
            req.method === "GET" &&
            pathname === "/health"
        ){

            sendJson(
                res,
                200,
                {
                    status:"ok",

                    derivConnected,

                    oauthConfigured:
                        Boolean(
                            DERIV_CLIENT_ID
                        ),

                    markets:
                        SYMBOLS.length,

                    timestamp:
                        Date.now()
                }
            );

            return;
        }

        /* STATUS */

        if(
            req.method === "GET" &&
            pathname === "/api/status"
        ){

            sendJson(
                res,
                200,
                {
                    success:true,

                    backend:"online",

                    derivConnected,

                    oauthConfigured:
                        Boolean(
                            DERIV_CLIENT_ID
                        ),

                    symbols:SYMBOLS
                }
            );

            return;
        }

        /* SESSION */

        if(
            req.method === "GET" &&
            pathname === "/api/session"
        ){

            const session =
                getSession(req);

            sendJson(
                res,
                200,
                {
                    authenticated:
                        Boolean(session),

                    user:
                        session?.data?.user ||
                        null
                }
            );

            return;
        }

        /* ACCOUNTS */

        if(
            req.method === "GET" &&
            pathname === "/api/accounts"
        ){

            const session =
                getSession(req);

            if(!session){

                sendJson(
                    res,
                    401,
                    {
                        success:false,
                        error:
                            "Not authenticated"
                    }
                );

                return;
            }

            sendJson(
                res,
                200,
                {
                    success:true,

                    accounts:
                        session.data.accounts ||
                        []
                }
            );

            return;
        }

        /* OAUTH STATUS */

        if(
            req.method === "GET" &&
            pathname === "/oauth/status"
        ){

            sendJson(
                res,
                200,
                {
                    oauthConfigured:
                        Boolean(
                            DERIV_CLIENT_ID
                        ),

                    redirectUri:
                        DERIV_REDIRECT_URI
                }
            );

            return;
        }

        /* OAUTH AUTHORIZE */

        if(
            req.method === "GET" &&
            pathname === "/oauth/authorize"
        ){

            if(!DERIV_CLIENT_ID){

                sendJson(
                    res,
                    500,
                    {
                        success:false,
                        error:
                            "DERIV_CLIENT_ID is not configured."
                    }
                );

                return;
            }

            const verifier =
                createVerifier();

            const challenge =
                createChallenge(
                    verifier
                );

            const state =
                createState();

            oauthStates.set(
                state,
                {
                    verifier,

                    createdAt:
                        Date.now()
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
                state
            );

            params.set(
                "code_challenge",
                challenge
            );

            params.set(
                "code_challenge_method",
                "S256"
            );

            const authorizationUrl =
                "https://auth.deriv.com/oauth2/auth?" +
                params.toString();

            redirect(
                res,
                authorizationUrl
            );

            return;
        }

        /* OAUTH CALLBACK */

        if(
            req.method === "GET" &&
            pathname === "/oauth/callback"
        ){

            const code =
                parsed.searchParams.get(
                    "code"
                );

            const state =
                parsed.searchParams.get(
                    "state"
                );

            const error =
                parsed.searchParams.get(
                    "error"
                );

            if(error){

                redirect(
                    res,
                    frontend(
                        "/login.html?oauth_error=" +
                        encodeURIComponent(error)
                    )
                );

                return;
            }

            if(!code || !state){

                sendJson(
                    res,
                    400,
                    {
                        success:false,
                        error:
                            "Missing OAuth code or state."
                    }
                );

                return;
            }

            const oauth =
                oauthStates.get(
                    state
                );

            if(!oauth){

                sendJson(
                    res,
                    400,
                    {
                        success:false,
                        error:
                            "Invalid or expired OAuth state."
                    }
                );

                return;
            }

            oauthStates.delete(state);

            try {

                /* TOKEN EXCHANGE */

                const tokenResponse =
                    await fetch(
                        "https://auth.deriv.com/oauth2/token",
                        {
                            method:"POST",

                            headers:{
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

                const tokenText =
                    await tokenResponse.text();

                let tokenData;

                try {

                    tokenData =
                        JSON.parse(
                            tokenText
                        );

                } catch {

                    tokenData = {
                        raw:tokenText
                    };

                }

                if(
                    !tokenResponse.ok ||
                    tokenData.error
                ){

                    console.error(
                        "OAuth token error:",
                        tokenData
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
                    tokenData.access_token;

                if(!accessToken){

                    redirect(
                        res,
                        frontend(
                            "/login.html?oauth_error=missing_access_token"
                        )
                    );

                    return;
                }

                /* ACCOUNT LOOKUP */

                let accounts = [];

                try {

                    const ws =
                        new WebSocket(
                            DERIV_WS_URL
                        );

                    accounts =
                        await new Promise(
                            resolve => {

                                let finished =
                                    false;

                                const finish =
                                    value => {

                                        if(finished)
                                            return;

                                        finished =
                                            true;

                                        clearTimeout(
                                            timer
                                        );

                                        try{
                                            ws.close();
                                        }catch{}

                                        resolve(value);
                                    };

                                const timer =
                                    setTimeout(
                                        () => {
                                            finish([]);
                                        },
                                        10000
                                    );

                                ws.on(
                                    "open",
                                    () => {

                                        ws.send(
                                            JSON.stringify({
                                                authorize:
                                                    accessToken
                                            })
                                        );

                                    }
                                );

                                ws.on(
                                    "message",
                                    raw => {

                                        try {

                                            const data =
                                                JSON.parse(
                                                    raw.toString()
                                                );

                                            if(
                                                data.error
                                            ){

                                                console.error(
                                                    "Account error:",
                                                    data.error
                                                );

                                                finish([]);

                                                return;
                                            }

                                            if(
                                                data.msg_type ===
                                                "authorize"
                                            ){

                                                finish([
                                                    {
                                                        loginid:
                                                            data.authorize?.loginid,

                                                        fullname:
                                                            data.authorize?.fullname,

                                                        currency:
                                                            data.authorize?.currency,

                                                        balance:
                                                            data.authorize?.balance,

                                                        email:
                                                            data.authorize?.email
                                                    }
                                                ]);

                                            }

                                        } catch {

                                            finish([]);

                                        }

                                    }
                                );

                                ws.on(
                                    "error",
                                    () => finish([])
                                );

                                ws.on(
                                    "close",
                                    () => {

                                        if(!finished)
                                            finish([]);

                                    }
                                );

                            }
                        );

                } catch(error){

                    console.error(
                        "Account lookup failed:",
                        error.message
                    );

                    accounts = [];

                }

                /* SESSION */

                const sessionId =
                    createSessionId();

                sessions.set(
                    sessionId,
                    {
                        accessToken,

                        accounts,

                        user:
                            accounts[0] ||
                            null,

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

                setSessionCookie(
                    res,
                    sessionId
                );

                console.log(
                    "OAuth successful."
                );

                redirect(
                    res,
                    frontend(
                        "/markets.html"
                    )
                );

                return;

            } catch(error){

                console.error(
                    "OAuth callback error:",
                    error
                );

                redirect(
                    res,
                    frontend(
                        "/login.html?oauth_error=oauth_callback_failed"
                    )
                );

                return;
            }
        }

        /* LOGOUT */

        if(
            req.method === "POST" &&
            pathname === "/api/logout"
        ){

            const session =
                getSession(req);

            if(session){

                sessions.delete(
                    session.id
                );

            }

            clearSessionCookie(res);

            sendJson(
                res,
                200,
                {
                    success:true
                }
            );

            return;
        }

        /* NOT FOUND */

        sendJson(
            res,
            404,
            {
                success:false,
                error:"Not found",
                path:pathname
            }
        );

    }
);

/* ==================================================
WEBSOCKET SERVER
================================================== */

const websocketServer =
new WebSocket.Server({
server
});

websocketServer.on(
"connection",
client => {

    clients.add(client);

    client.send(
        JSON.stringify({
            type:"status",
            connected:
                derivConnected
        })
    );

    client.on(
        "close",
        () => {
            clients.delete(client);
        }
    );

    client.on(
        "error",
        () => {
            clients.delete(client);
        }
    );

}

);

/* ==================================================
START SERVER
================================================== */

server.listen(
PORT,
() => {

    console.log(
        "======================================"
    );

    console.log(
        "MUKHU BACKEND STARTED"
    );

    console.log(
        "======================================"
    );

    console.log(
        "Port:",
        PORT
    );

    console.log(
        "Backend:",
        BACKEND_URL
    );

    console.log(
        "Frontend:",
        FRONTEND_URL
    );

    console.log(
        "OAuth configured:",
        Boolean(
            DERIV_CLIENT_ID
        )
    );

    console.log(
        "OAuth redirect:",
        DERIV_REDIRECT_URI
    );

    console.log(
        "Markets:",
        SYMBOLS.length
    );

    console.log(
        "======================================"
    );

    connectDeriv();

}

);

/* ==================================================
ERROR HANDLERS
================================================== */

process.on(
"uncaughtException",
error => {

    console.error(
        "UNCAUGHT EXCEPTION:",
        error
    );

}

);

process.on(
"unhandledRejection",
error => {

    console.error(
        "UNHANDLED REJECTION:",
        error
    );

}

);
