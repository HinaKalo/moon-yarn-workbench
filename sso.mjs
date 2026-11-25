import { randomBytes } from "node:crypto";
import { Router } from "express";
import * as oidc from "openid-client";
import { loginPage } from "./login-page.mjs";

const pendingCookie = "__Host-yarn-request";
const sessionCookie = "__Host-yarn-session";
const cookieOptions = { httpOnly: true, secure: true, sameSite: "lax", path: "/" };
const pendingTTL = 10 * 60_000;
const recheckAfter = 60_000;
const maxEntries = 1024;

function token() {
  return randomBytes(32).toString("base64url");
}

function readCookie(req, name) {
  const cookies = (req.headers.cookie || "").split(";");
  const prefix = `${name}=`;
  const value = cookies.map((entry) => entry.trim()).find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
  return /^[\w-]{43}$/.test(value || "") ? value : "";
}

function validDestination(value) {
  if (typeof value !== "string" || value.length > 200 || !/^\/(?:\?.*)?$/.test(value)) return "/";
  const params = new URLSearchParams(value.slice(2));
  const script = params.get("script");
  return /^[0-9a-f-]{36}$/i.test(script || "") ? `/?script=${script}` : "/";
}

function getEntry(map, id) {
  const entry = map.get(id);
  if (entry && entry.until > Date.now()) return entry;
  map.delete(id);
  return undefined;
}

function putEntry(map, id, value) {
  for (const [key, entry] of map) {
    if (entry.until <= Date.now()) map.delete(key);
  }
  if (map.size >= maxEntries) map.delete(map.keys().next().value);
  map.set(id, value);
}

export function makeSso({ origin, issuer, clientId, secret }) {
  const router = Router();
  const pending = new Map();
  const sessions = new Map();
  const callback = new URL("/auth/callback", origin);
  let connection;

  function connect() {
    connection ??= oidc.discovery(new URL(issuer), clientId, undefined, oidc.ClientSecretBasic(secret))
      .then((config) => {
        oidc.enableNonRepudiationChecks(config);
        return config;
      }).catch((error) => {
        connection = undefined;
        throw error;
      });
    return connection;
  }

  function sendLogin(res, destination = "/", { status = 200, message = "" } = {}) {
    res.set({
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    }).status(status).type("html").send(loginPage(destination, message));
  }

  async function activeSession(req, res) {
    const id = readCookie(req, sessionCookie);
    const session = getEntry(sessions, id);
    if (!session) return undefined;
    if (session.checked + recheckAfter <= Date.now()) {
      session.checking ??= connect().then((config) =>
        oidc.fetchUserInfo(config, session.accessToken, session.sub)
      ).then(() => { session.checked = Date.now(); })
        .finally(() => { session.checking = undefined; });
      try {
        await session.checking;
      } catch {
        sessions.delete(id);
        res.clearCookie(sessionCookie, cookieOptions);
        return undefined;
      }
    }
    return session;
  }

  router.get("/auth/start", async (req, res) => {
    const destination = validDestination(req.query.next);
    try {
      const config = await connect();
      const verifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const id = token();
      const challenge = await oidc.calculatePKCECodeChallenge(verifier);
      const authorization = oidc.buildAuthorizationUrl(config, {
        redirect_uri: callback.href, scope: "openid", code_challenge: challenge,
        code_challenge_method: "S256", state, nonce,
      });
      pending.delete(readCookie(req, pendingCookie));
      putEntry(pending, id, { verifier, state, nonce, destination, until: Date.now() + pendingTTL });
      res.set("Cache-Control", "no-store").cookie(pendingCookie, id, { ...cookieOptions, maxAge: pendingTTL })
        .redirect(303, authorization.href);
    } catch {
      sendLogin(res, destination, { status: 503, message: "Moon SSO 暂时无法连接，请稍后重试。" });
    }
  });

  router.get("/auth/callback", async (req, res) => {
    const key = readCookie(req, pendingCookie);
    const request = getEntry(pending, key);
    pending.delete(key);
    res.clearCookie(pendingCookie, cookieOptions);
    if (!request) {
      sendLogin(res, "/", { status: 400, message: "登录链接已失效，请重新登录。" });
      return;
    }
    try {
      const config = await connect();
      const tokens = await oidc.authorizationCodeGrant(config, new URL(req.originalUrl, origin), {
        pkceCodeVerifier: request.verifier, expectedState: request.state, expectedNonce: request.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      const until = Date.now() + Math.min(tokens.expiresIn() || 0, 3600) * 1000;
      if (!claims?.sub || until <= Date.now()) throw new Error("Invalid session");
      const id = token();
      sessions.delete(readCookie(req, sessionCookie));
      putEntry(sessions, id, { sub: claims.sub, accessToken: tokens.access_token, checked: Date.now(), until });
      res.set("Cache-Control", "no-store").cookie(sessionCookie, id, { ...cookieOptions, maxAge: until - Date.now() })
        .redirect(303, request.destination);
    } catch (error) {
      console.warn("Yarn SSO callback rejected", error.code || error.name);
      sendLogin(res, request.destination, { status: 401, message: "登录未完成，请重新尝试。" });
    }
  });

  router.post("/auth/logout", (req, res) => {
    if (req.headers.origin !== origin) return res.status(403).end();
    sessions.delete(readCookie(req, sessionCookie));
    res.set("Cache-Control", "no-store").clearCookie(sessionCookie, cookieOptions).redirect(303, "/");
  });

  router.use(async (req, res, next) => {
    const page = req.path === "/" || req.path.toLowerCase() === "/index.html";
    if (req.path.startsWith("/assets/")) return next();
    res.set("Cache-Control", "no-store");
    if (await activeSession(req, res)) return next();
    if (page && (req.method === "GET" || req.method === "HEAD")) {
      sendLogin(res, req.path === "/" ? validDestination(req.originalUrl) : "/");
      return;
    }
    res.status(401).json({ error: "请先通过 Moon SSO 登录 Yarn 工作台" });
  });
  return router;
}
