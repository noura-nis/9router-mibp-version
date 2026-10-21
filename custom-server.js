const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

const origCreate = http.createServer.bind(http);

// Per-process secret proving x-9r-real-ip was stamped below rather than sent by the client.
// A bare `next start` / `next dev` never loads this file, so it cannot produce a matching
// header even though the env var is inherited by child processes. Named like x-9r-cli-token
// so the request-detail header sanitizer redacts it too.
const PEER_TOKEN = crypto.randomBytes(24).toString("hex");
process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;

let backgroundRefreshStarted = false;
let devraStarted = false;

// -------------------------------------------------------------
// Supabase Database Persistence & Auto-Sync
// -------------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL || "https://hgfftqiyqowuvpwiybhs.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhnZmZ0cWl5cW93dXZwd2l5YmhzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MjM4MTMzNCwiZXhwIjoyMTA3OTU3MzM0fQ.bmLAmDCizeTS7KY2JWp3mG2YcMMllb_vhe0FXpkirW0";
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "9router-persistence";

function getLocalDbPath() {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
  return path.join(dataDir, "db", "data.sqlite");
}

async function restoreFromSupabaseSync() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  const targetFile = getLocalDbPath();
  const dbDir = path.dirname(targetFile);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

  try {
    console.log("[Supabase Sync] Checking for persistent database in Supabase Storage...");
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/data.sqlite`, {
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`
      }
    });

    if (res.ok) {
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > 0) {
        fs.writeFileSync(targetFile, buffer);
        console.log(`[Supabase Sync] ✅ Successfully restored data.sqlite (${buffer.length} bytes) from Supabase! All accounts and combos preserved.`);
        return true;
      }
    } else {
      console.log(`[Supabase Sync] No existing backup found in bucket (HTTP ${res.status}). Ready for fresh sync.`);
    }
  } catch (err) {
    console.warn("[Supabase Sync] Restore skipped or failed:", err.message);
  }
  return false;
}

async function backupToSupabaseSync() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  const targetFile = getLocalDbPath();
  if (!fs.existsSync(targetFile)) return;

  try {
    const fileData = fs.readFileSync(targetFile);
    if (!fileData || fileData.length === 0) return;

    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/data.sqlite`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/octet-stream",
        "x-upsert": "true"
      },
      body: fileData
    });

    if (res.ok) {
      console.log(`[Supabase Sync] 💾 Database snapshot (${fileData.length} bytes) backed up to Supabase bucket.`);
    } else {
      console.warn(`[Supabase Sync] Backup failed with HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn("[Supabase Sync] Backup error:", err.message);
  }
}

// Trigger restore on boot before app starts serving
restoreFromSupabaseSync();

function startDevraAgentFromCustomServer() {
  if (devraStarted) return;
  devraStarted = true;
  const devraScript = path.join(__dirname, "devra-agent.mjs");
  if (!fs.existsSync(devraScript)) {
    console.log("[DEVRA] Agent script not found at " + devraScript);
    return;
  }
  const { fork } = require("child_process");
  console.log("[DEVRA] Spawning Autonomous Software Engineering Agent...");
  let child = null;
  const launch = () => {
    try {
      child = fork(devraScript, [], {
        stdio: "inherit",
        env: { ...process.env }
      });
      child.on("exit", (code) => {
        console.warn(`[DEVRA] Agent exited with code ${code}. Restarting in 5s...`);
        setTimeout(launch, 5000);
      });
    } catch (err) {
      console.error("[DEVRA] Failed to launch agent:", err.message);
    }
  };
  launch();
  const cleanup = () => {
    if (child) {
      try { child.kill(); } catch (e) {}
    }
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
}

function startBackgroundTokenRefreshFromCustomServer() {
  if (backgroundRefreshStarted) return;
  backgroundRefreshStarted = true;
  // Prefer source path (repo / standalone that still has src). Fail-open if missing
  // — initializeApp also starts the same scheduler when the Next app boots.
  const modPath = path.join(__dirname, "src", "sse", "services", "backgroundTokenRefresh.js");
  import(pathToFileURL(modPath).href)
    .then((m) => {
      try {
        m.startBackgroundTokenRefresh();
      } catch (e) {
        console.error("[BackgroundTokenRefresh] start failed:", e && e.message ? e.message : e);
      }
      const stop = () => {
        try {
          m.stopBackgroundTokenRefresh();
        } catch {
          /* ignore */
        }
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    })
    .catch((e) => {
      // Expected in published CLI standalone (src/ not on disk). App bootstrap covers it.
      if (process.env.DEBUG_BACKGROUND_TOKEN_REFRESH) {
        console.error("[BackgroundTokenRefresh] import failed:", e && e.message ? e.message : e);
      }
    });
}

// Wrap Next standalone HTTP server: derive client IP from the TCP socket
// (unspoofable) and strip client-supplied forwarding headers so downstream
// rate-limiting keys on the real peer address instead of attacker-controlled XFF.
http.createServer = (...args) => {
  const handler = args.find((a) => typeof a === "function");
  const rest = args.filter((a) => typeof a !== "function");
  if (!handler) return origCreate(...args);
  const wrapped = (req, res) => {
    const socketIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
    const xff = req.headers["x-forwarded-for"];
    const xRealIp = req.headers["x-real-ip"];
    const viaProxy = !!(xff || xRealIp);
    const isLoopbackProxy = socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1";
    // Trust forwarding headers only when the TCP peer is a local reverse proxy.
    // Direct/public sockets remain keyed by the unspoofable peer address.
    const proxyIp = xRealIp || (xff ? String(xff).split(",")[0].trim() : "");
    const ip = isLoopbackProxy && proxyIp ? proxyIp : socketIp;
    delete req.headers["x-9r-real-ip"];
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-9r-via-proxy"];
    delete req.headers["x-9r-peer-token"];
    req.headers["x-9r-real-ip"] = ip;
    req.headers["x-9r-peer-token"] = PEER_TOKEN;
    if (viaProxy) req.headers["x-9r-via-proxy"] = "1";
    return handler(req, res);
  };
  const server = origCreate(...rest, wrapped);
  server.once("listening", () => {
    startBackgroundTokenRefreshFromCustomServer();
    startDevraAgentFromCustomServer();
    // Schedule periodic backup to Supabase every 3 minutes
    setInterval(backupToSupabaseSync, 180000);
    setTimeout(backupToSupabaseSync, 15000);
  });
  const handleShutdown = async () => {
    console.log("[Supabase Sync] Server shutting down, uploading final database snapshot...");
    try { await backupToSupabaseSync(); } catch {}
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
  const origEmit = server.emit;
  // JBR 25 sends h2c upgrades that the HTTP/1.1 server would otherwise close.
  server.emit = function (event, ...eventArgs) {
    const [req, socket, head] = eventArgs;
    if (event !== "upgrade" || String(req.headers.upgrade || "").toLowerCase() !== "h2c") {
      return origEmit.call(this, event, ...eventArgs);
    }

    const contentLength = Number(req.headers["content-length"] || 0);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      socket.destroy();
      return true;
    }
    const chunks = [head];
    let received = head.length;
    const serve = () => {
      // Replay the upgraded request through the existing HTTP/1.1 handler.
      const replay = new http.IncomingMessage(socket);
      Object.assign(replay, { method: req.method, url: req.url, headers: req.headers, complete: true });
      if (received) replay.push(Buffer.concat(chunks, received).subarray(0, contentLength));
      replay.push(null);
      const res = new http.ServerResponse(replay);
      res.shouldKeepAlive = false;
      res.assignSocket(socket);
      res.once("finish", () => socket.end());
      Promise.resolve().then(() => wrapped(replay, res)).catch((error) => {
        console.error("Failed to downgrade h2c request", error);
        socket.destroy();
      });
    };
    if (received >= contentLength) serve();
    else {
      socket.on("data", function readBody(chunk) {
        chunks.push(chunk);
        received += chunk.length;
        if (received < contentLength) return;
        socket.off("data", readBody);
        serve();
      });
      socket.resume();
    }
    delete req.headers.upgrade;
    delete req.headers["http2-settings"];
    req.headers.connection = "close";
    return true;
  };
  return server;
};

if (require.main === module) {
  const standalone = path.join(__dirname, "server.js");
  if (fs.existsSync(standalone)) {
    require(standalone);
  } else {
    // Repo checkout has no standalone build next to us. `next start` builds its HTTP
    // server in-process, so the wrapper above still sanitizes every request.
    const nextBin = require.resolve("next/dist/bin/next");
    process.argv = [process.argv[0], nextBin, "start", ...process.argv.slice(2)];
    require(nextBin);
  }
}
