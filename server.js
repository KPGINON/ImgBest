const { createServer } = require("node:http");
const { readFile, stat, writeFile, mkdir } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { URL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const DB_PATH = path.join(DATA_DIR, "imgbest.sqlite3");
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_SIZE = 40 * 1024 * 1024;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

let database;

async function ensureStorage() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(UPLOAD_DIR, { recursive: true });

  database = new DatabaseSync(DB_PATH);
  database.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      workflow TEXT NOT NULL,
      status TEXT NOT NULL,
      prompt TEXT,
      payload_json TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      role TEXT NOT NULL,
      original_name TEXT,
      mime_type TEXT,
      file_path TEXT NOT NULL,
      public_url TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(id)
    );
  `);
}

function nowIso() {
  return new Date().toISOString();
}

function sendJson(response, statusCode, data) {
  const body = Buffer.from(JSON.stringify(data, null, 2));
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  response.end(body);
}

function sendError(response, statusCode, message) {
  sendJson(response, statusCode, { error: message });
}

async function readJsonBody(request) {
  const chunks = [];
  let totalLength = 0;

  for await (const chunk of request) {
    totalLength += chunk.length;
    if (totalLength > MAX_BODY_SIZE) {
      throw new Error("Request body is too large");
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function extensionFromMime(mimeType) {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  return ".bin";
}

function parseDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") return null;
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) return null;
  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], "base64"),
    extension: extensionFromMime(match[1]),
  };
}

function getOriginalName(payload, role) {
  const bagViews = payload.inputs?.bagViews || {};
  const mappedRole = {
    bagFront: "front",
    bagLeft45: "left45",
    bagRight45: "right45",
    bagTop: "top",
  }[role];

  if (mappedRole) return bagViews[mappedRole] || null;
  return payload.inputs?.[role] || null;
}

async function saveEmbeddedImages(taskId, payload) {
  const imageData = payload.imageData;
  if (!imageData || typeof imageData !== "object") return [];

  const savedAssets = [];

  for (const [role, dataUrl] of Object.entries(imageData)) {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) continue;

    const assetId = `asset_${randomUUID().replaceAll("-", "")}`;
    const filename = `${assetId}${parsed.extension}`;
    const diskPath = path.join(UPLOAD_DIR, filename);
    await writeFile(diskPath, parsed.buffer);

    savedAssets.push({
      id: assetId,
      taskId,
      role,
      originalName: getOriginalName(payload, role),
      mimeType: parsed.mimeType,
      filePath: path.relative(ROOT, diskPath),
      publicUrl: `/uploads/${filename}`,
      sizeBytes: parsed.buffer.length,
    });
  }

  return savedAssets;
}

function publicAssetForRole(assets, role) {
  return assets.find((asset) => asset.role === role)?.publicUrl || null;
}

function makeStoredResponse(taskId, payload, assets) {
  if (payload.workflow === "model-bag-replacement") {
    return {
      id: taskId,
      status: "stored",
      provider: "node-sqlite",
      imageUrl: publicAssetForRole(assets, "modelImage") || "/assets/hero-bag-model.png",
      assets,
      message: "换包任务已写入数据库。接入 ComfyUI 后在此返回真实生成图。",
    };
  }

  const variantPrompts = payload.variantPrompts?.length ? payload.variantPrompts : [payload.prompt || ""];
  return {
    id: taskId,
    status: "stored",
    provider: "node-sqlite",
    imageUrl: "/assets/hero-bag-model.png",
    variants: variantPrompts.map((prompt, index) => ({
      id: `v${index + 1}`,
      imageUrl: "/assets/hero-bag-model.png",
      prompt,
    })),
    assets,
    message: "商品图任务已写入数据库。接入 ComfyUI 后在此返回真实生成图。",
  };
}

function insertTask(taskId, payload, response, assets) {
  const timestamp = nowIso();
  const insertTaskStmt = database.prepare(`
    INSERT INTO tasks (id, workflow, status, prompt, payload_json, response_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAssetStmt = database.prepare(`
    INSERT INTO assets (id, task_id, role, original_name, mime_type, file_path, public_url, size_bytes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  database.exec("BEGIN");
  try {
    insertTaskStmt.run(
      taskId,
      payload.workflow || "unknown",
      response.status || "stored",
      payload.prompt || "",
      JSON.stringify(payload),
      JSON.stringify(response),
      timestamp,
      timestamp,
    );

    for (const asset of assets) {
      insertAssetStmt.run(
        asset.id,
        taskId,
        asset.role,
        asset.originalName,
        asset.mimeType,
        asset.filePath,
        asset.publicUrl,
        asset.sizeBytes,
        timestamp,
      );
    }

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function taskRowToJson(row) {
  return {
    id: row.id,
    workflow: row.workflow,
    status: row.status,
    prompt: row.prompt,
    response: JSON.parse(row.response_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function handleGenerateImage(request, response) {
  try {
    const payload = await readJsonBody(request);
    const taskId = `task_${randomUUID().replaceAll("-", "")}`;
    const assets = await saveEmbeddedImages(taskId, payload);
    const storedResponse = makeStoredResponse(taskId, payload, assets);
    insertTask(taskId, payload, storedResponse, assets);
    sendJson(response, 201, storedResponse);
  } catch (error) {
    if (error instanceof SyntaxError) {
      sendError(response, 400, "Invalid JSON body");
      return;
    }
    if (error.message.includes("too large")) {
      sendError(response, 413, error.message);
      return;
    }
    sendError(response, 500, error.message);
  }
}

function handleListTasks(requestUrl, response) {
  const limit = Math.min(Number(requestUrl.searchParams.get("limit") || 20), 100);
  const rows = database
    .prepare(
      `
      SELECT id, workflow, status, prompt, response_json, created_at, updated_at
      FROM tasks
      ORDER BY created_at DESC
      LIMIT ?
    `,
    )
    .all(limit);

  sendJson(response, 200, { tasks: rows.map(taskRowToJson) });
}

function handleGetTask(taskId, response) {
  const task = database
    .prepare(
      `
      SELECT id, workflow, status, prompt, response_json, created_at, updated_at
      FROM tasks
      WHERE id = ?
    `,
    )
    .get(taskId);

  if (!task) {
    sendError(response, 404, "Task not found");
    return;
  }

  const assets = database
    .prepare(
      `
      SELECT id, role, original_name, mime_type, public_url, size_bytes, created_at
      FROM assets
      WHERE task_id = ?
      ORDER BY created_at ASC
    `,
    )
    .all(taskId)
    .map((asset) => ({
      id: asset.id,
      role: asset.role,
      originalName: asset.original_name,
      mimeType: asset.mime_type,
      publicUrl: asset.public_url,
      sizeBytes: asset.size_bytes,
      createdAt: asset.created_at,
    }));

  sendJson(response, 200, { ...taskRowToJson(task), assets });
}

async function serveStatic(requestUrl, response) {
  const requestedPath = decodeURIComponent(requestUrl.pathname);
  const relativePath = requestedPath === "/" ? "index.html" : requestedPath.slice(1);
  const filePath = path.normalize(path.join(ROOT, relativePath));

  if (!filePath.startsWith(ROOT)) {
    sendError(response, 403, "Forbidden");
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      sendError(response, 404, "Not found");
      return;
    }

    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Content-Length": body.length,
    });
    response.end(body);
  } catch {
    sendError(response, 404, "Not found");
  }
}

async function route(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    response.end();
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      database: path.relative(ROOT, DB_PATH),
      databaseExists: existsSync(DB_PATH),
    });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/tasks") {
    handleListTasks(requestUrl, response);
    return;
  }

  if (request.method === "GET" && requestUrl.pathname.startsWith("/api/tasks/")) {
    handleGetTask(requestUrl.pathname.split("/").pop(), response);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/generate-image") {
    await handleGenerateImage(request, response);
    return;
  }

  if (request.method === "GET") {
    await serveStatic(requestUrl, response);
    return;
  }

  sendError(response, 405, "Method not allowed");
}

ensureStorage().then(() => {
  createServer((request, response) => {
    route(request, response).catch((error) => sendError(response, 500, error.message));
  }).listen(PORT, "127.0.0.1", () => {
    console.log(`ImgBest server running at http://127.0.0.1:${PORT}`);
    console.log(`SQLite database: ${DB_PATH}`);
  });
});
