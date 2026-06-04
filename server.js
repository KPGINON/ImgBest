const { createServer } = require("node:http");
const { readFile, stat, writeFile, mkdir } = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { URL } = require("node:url");

const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, "uploads");
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_SIZE = 40 * 1024 * 1024;
const CREDIT_SCALE = 10;
const INVITE_REWARD_CREDITS = 5 * CREDIT_SCALE;
const GENERATION_COSTS = {
  basic: 5 * CREDIT_SCALE,
  pro: 9.9 * CREDIT_SCALE,
  premium: 19.9 * CREDIT_SCALE,
};
const CREDIT_PACKS = {
  p100: { id: "p100", name: "轻量充值", amountCents: 10000, creditUnits: 100 * CREDIT_SCALE, bonusRate: 0 },
  p300: { id: "p300", name: "常用充值", amountCents: 30000, creditUnits: 315 * CREDIT_SCALE, bonusRate: 0.05 },
  p500: { id: "p500", name: "商家充值", amountCents: 50000, creditUnits: 550 * CREDIT_SCALE, bonusRate: 0.1 },
  p1000: { id: "p1000", name: "团队充值", amountCents: 100000, creditUnits: 1150 * CREDIT_SCALE, bonusRate: 0.15 },
  p2000: { id: "p2000", name: "大客户充值", amountCents: 200000, creditUnits: 2400 * CREDIT_SCALE, bonusRate: 0.2 },
};
const PLAN_CONFIGS = {
  basic: {
    id: "basic",
    name: "基础试单",
    amountCents: 9900,
    rank: 1,
    features: ["ecommerce-product-image"],
  },
  pro: {
    id: "pro",
    name: "主推套餐",
    amountCents: 19900,
    rank: 2,
    features: ["ecommerce-product-image", "model-bag-replacement", "commercial-selected"],
  },
  premium: {
    id: "premium",
    name: "精修交付",
    amountCents: 29900,
    rank: 3,
    features: ["ecommerce-product-image", "model-bag-replacement", "commercial-selected", "manual-retouch"],
  },
};

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

const store = {
  accounts: new Map(),
  entitlements: new Map(),
  payments: new Map(),
  tasks: new Map(),
  assets: new Map(),
  creditLedger: [],
};

async function ensureStorage() {
  await mkdir(UPLOAD_DIR, { recursive: true });
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
    "Access-Control-Allow-Headers": "Content-Type, X-Client-Id",
  });
  response.end(body);
}

function sendError(response, statusCode, message) {
  sendJson(response, statusCode, { error: message });
}

function getClientId(request) {
  const clientId = request.headers["x-client-id"];
  return typeof clientId === "string" && clientId.trim() ? clientId.trim().slice(0, 120) : null;
}

function formatCredits(units) {
  const value = units / CREDIT_SCALE;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function makeInviteCode() {
  return `IB${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
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

    const asset = {
      id: assetId,
      taskId,
      role,
      originalName: getOriginalName(payload, role),
      mimeType: parsed.mimeType,
      filePath: path.relative(ROOT, diskPath),
      publicUrl: `/uploads/${filename}`,
      sizeBytes: parsed.buffer.length,
      createdAt: nowIso(),
    };
    store.assets.set(assetId, asset);
    savedAssets.push(asset);
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
      provider: "memory",
      imageUrl: publicAssetForRole(assets, "modelImage") || "/assets/hero-bag-model.png",
      assets,
      message: "换包任务已暂存到内存。接入数据库后可持久化保存。",
    };
  }

  const variantPrompts = payload.variantPrompts?.length ? payload.variantPrompts : [payload.prompt || ""];
  return {
    id: taskId,
    status: "stored",
    provider: "memory",
    imageUrl: "/assets/hero-bag-model.png",
    variants: variantPrompts.map((prompt, index) => ({
      id: `v${index + 1}`,
      imageUrl: "/assets/hero-bag-model.png",
      prompt,
    })),
    assets,
    message: "商品图任务已暂存到内存。接入数据库后可持久化保存。",
  };
}

function taskToJson(task) {
  return {
    id: task.id,
    clientId: task.clientId,
    workflow: task.workflow,
    status: task.status,
    prompt: task.prompt,
    response: task.response,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function insertTask(taskId, payload, response, assets, creditCharge = null) {
  const timestamp = nowIso();
  const task = {
    id: taskId,
    clientId: creditCharge?.clientId || null,
    workflow: payload.workflow || "unknown",
    status: response.status || "stored",
    prompt: payload.prompt || "",
    payload,
    response,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  store.tasks.set(taskId, task);
  for (const asset of assets) {
    store.assets.set(asset.id, asset);
  }

  if (creditCharge) {
    addCreditEntry(creditCharge.clientId, -creditCharge.amountUnits, creditCharge.reason, taskId);
  }
}

function publicPlan(plan) {
  return {
    id: plan.id,
    name: plan.name,
    amountCents: plan.amountCents,
    priceLabel: `${Math.floor(plan.amountCents / 100)} 元`,
    creditGrant: Number(formatCredits(plan.amountCents / 10)),
    features: plan.features,
  };
}

function publicCreditPack(pack) {
  return {
    id: pack.id,
    name: pack.name,
    amountCents: pack.amountCents,
    priceLabel: `${Math.floor(pack.amountCents / 100)} 元`,
    creditGrant: Number(formatCredits(pack.creditUnits)),
    bonusRate: pack.bonusRate,
    bonusLabel: pack.bonusRate ? `赠送 ${Math.round(pack.bonusRate * 100)}%` : "无赠送",
  };
}

function paymentToJson(payment) {
  return {
    id: payment.id,
    clientId: payment.clientId,
    planId: payment.planId,
    amountCents: payment.amountCents,
    status: payment.status,
    createdAt: payment.createdAt,
    paidAt: payment.paidAt,
  };
}

function entitlementToJson(entitlement) {
  if (!entitlement) return null;
  const plan = PLAN_CONFIGS[entitlement.planId];
  return {
    clientId: entitlement.clientId,
    planId: entitlement.planId,
    planName: plan?.name || entitlement.planId,
    rank: plan?.rank || 0,
    features: plan?.features || [],
    startsAt: entitlement.startsAt,
    expiresAt: entitlement.expiresAt,
    updatedAt: entitlement.updatedAt,
  };
}

function getEntitlement(clientId) {
  if (!clientId) return null;
  return entitlementToJson(store.entitlements.get(clientId));
}

function accountToJson(account) {
  if (!account) return null;
  return {
    clientId: account.clientId,
    inviteCode: account.inviteCode,
    referredBy: account.referredBy,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function getAccount(clientId) {
  return accountToJson(store.accounts.get(clientId));
}

function ensureAccount(clientId) {
  if (!clientId) return null;
  const existing = store.accounts.get(clientId);
  if (existing) return accountToJson(existing);

  const timestamp = nowIso();
  let inviteCode = makeInviteCode();
  while ([...store.accounts.values()].some((account) => account.inviteCode === inviteCode)) {
    inviteCode = makeInviteCode();
  }

  const account = {
    clientId,
    inviteCode,
    referredBy: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  store.accounts.set(clientId, account);
  return accountToJson(account);
}

function getCreditBalanceUnits(clientId) {
  if (!clientId) return 0;
  return store.creditLedger
    .filter((entry) => entry.clientId === clientId)
    .reduce((total, entry) => total + entry.amountUnits, 0);
}

function addCreditEntry(clientId, amountUnits, reason, referenceId = null) {
  ensureAccount(clientId);
  store.creditLedger.push({
    id: `credit_${randomUUID().replaceAll("-", "")}`,
    clientId,
    amountUnits: Math.round(amountUnits),
    reason,
    referenceId,
    createdAt: nowIso(),
  });
}

function getRecentCreditLedger(clientId, limit = 8) {
  return store.creditLedger
    .filter((entry) => entry.clientId === clientId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit)
    .map((entry) => ({
      id: entry.id,
      amountUnits: entry.amountUnits,
      amountCredits: Number(formatCredits(entry.amountUnits)),
      reason: entry.reason,
      referenceId: entry.referenceId,
      createdAt: entry.createdAt,
    }));
}

function accountSummary(clientId) {
  const account = ensureAccount(clientId);
  const balanceUnits = getCreditBalanceUnits(clientId);
  return {
    account,
    credits: {
      balanceUnits,
      balance: Number(formatCredits(balanceUnits)),
      inviteReward: Number(formatCredits(INVITE_REWARD_CREDITS)),
      costs: {
        basic: Number(formatCredits(GENERATION_COSTS.basic)),
        pro: Number(formatCredits(GENERATION_COSTS.pro)),
        premium: Number(formatCredits(GENERATION_COSTS.premium)),
      },
    },
    ledger: getRecentCreditLedger(clientId),
  };
}

function applyReferral(clientId, inviteCode) {
  const account = ensureAccount(clientId);
  if (!inviteCode || account.referredBy) return accountSummary(clientId);

  const inviter = [...store.accounts.values()].find((item) => item.inviteCode === String(inviteCode).trim());
  if (!inviter || inviter.clientId === clientId) return accountSummary(clientId);

  const target = store.accounts.get(clientId);
  target.referredBy = inviter.clientId;
  target.updatedAt = nowIso();
  addCreditEntry(inviter.clientId, INVITE_REWARD_CREDITS, "invite_reward", clientId);

  return accountSummary(clientId);
}

function minimumPlanForPayload(payload) {
  if (payload.workflow === "model-bag-replacement") return "pro";
  if (payload.deliveryTier?.startsWith("manual retouch review") || payload.generationMode === "premium") return "premium";
  if (payload.deliveryTier?.includes("commercial-ready")) return "pro";
  return "basic";
}

function creditCostForPlan(planId) {
  return GENERATION_COSTS[planId] || GENERATION_COSTS.basic;
}

function assertPlanAccess(request, payload) {
  const clientId = getClientId(request);
  const requiredPlanId = minimumPlanForPayload(payload);
  return { allowed: Boolean(clientId), statusCode: clientId ? 200 : 400, clientId, requiredPlanId };
}

function handleListPlans(response) {
  sendJson(response, 200, {
    plans: Object.values(PLAN_CONFIGS).map(publicPlan),
    creditPacks: Object.values(CREDIT_PACKS).map(publicCreditPack),
    generationCosts: {
      basic: Number(formatCredits(GENERATION_COSTS.basic)),
      pro: Number(formatCredits(GENERATION_COSTS.pro)),
      premium: Number(formatCredits(GENERATION_COSTS.premium)),
    },
  });
}

function handleCurrentEntitlement(request, response) {
  const clientId = getClientId(request);
  if (clientId) ensureAccount(clientId);
  sendJson(response, 200, { entitlement: getEntitlement(clientId), account: clientId ? accountSummary(clientId) : null });
}

function handleGetAccount(request, response) {
  const clientId = getClientId(request);
  if (!clientId) {
    sendError(response, 400, "Missing X-Client-Id");
    return;
  }
  sendJson(response, 200, accountSummary(clientId));
}

async function handleApplyReferral(request, response) {
  try {
    const clientId = getClientId(request);
    if (!clientId) {
      sendError(response, 400, "Missing X-Client-Id");
      return;
    }
    const payload = await readJsonBody(request);
    sendJson(response, 200, applyReferral(clientId, payload.inviteCode));
  } catch (error) {
    if (error instanceof SyntaxError) {
      sendError(response, 400, "Invalid JSON body");
      return;
    }
    sendError(response, 500, error.message);
  }
}

async function handleCreatePayment(request, response) {
  try {
    const clientId = getClientId(request);
    if (!clientId) {
      sendError(response, 400, "Missing X-Client-Id");
      return;
    }

    const payload = await readJsonBody(request);
    const plan = PLAN_CONFIGS[payload.planId];
    const creditPack = CREDIT_PACKS[payload.packId];
    if (!plan && !creditPack) {
      sendError(response, 400, "Unknown planId or packId");
      return;
    }
    ensureAccount(clientId);
    const paymentTarget = creditPack || plan;

    const paymentId = `pay_${randomUUID().replaceAll("-", "")}`;
    const timestamp = nowIso();
    const payment = {
      id: paymentId,
      clientId,
      planId: paymentTarget.id,
      amountCents: paymentTarget.amountCents,
      status: "pending",
      createdAt: timestamp,
      paidAt: null,
    };
    store.payments.set(paymentId, payment);

    sendJson(response, 201, {
      payment: {
        id: paymentId,
        plan: plan ? publicPlan(plan) : null,
        creditPack: creditPack ? publicCreditPack(creditPack) : null,
        status: "pending",
        mockPayUrl: `/api/payments/${paymentId}/confirm`,
      },
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      sendError(response, 400, "Invalid JSON body");
      return;
    }
    sendError(response, 500, error.message);
  }
}

async function handleConfirmPayment(request, response) {
  const clientId = getClientId(request);
  if (!clientId) {
    sendError(response, 400, "Missing X-Client-Id");
    return;
  }

  const paymentId = request.url.split("/").at(-2);
  const payment = store.payments.get(paymentId);
  if (!payment || payment.clientId !== clientId) {
    sendError(response, 404, "Payment not found");
    return;
  }

  const plan = PLAN_CONFIGS[payment.planId];
  const creditPack = CREDIT_PACKS[payment.planId];
  if (!plan && !creditPack) {
    sendError(response, 400, "Payment plan is invalid");
    return;
  }

  const timestamp = nowIso();
  payment.status = "paid";
  payment.paidAt = timestamp;

  if (plan) {
    store.entitlements.set(clientId, {
      clientId,
      planId: plan.id,
      paymentId,
      startsAt: timestamp,
      expiresAt: null,
      updatedAt: timestamp,
    });
    addCreditEntry(clientId, plan.amountCents / 10, "payment_credit", paymentId);
  } else {
    addCreditEntry(clientId, creditPack.creditUnits, "credit_recharge", paymentId);
  }

  sendJson(response, 200, {
    payment: paymentToJson(payment),
    entitlement: getEntitlement(clientId),
    account: accountSummary(clientId),
  });
}

async function handleGenerateImage(request, response) {
  try {
    const payload = await readJsonBody(request);
    const access = assertPlanAccess(request, payload);
    if (!access.allowed) {
      sendJson(response, access.statusCode, { error: "Missing X-Client-Id" });
      return;
    }

    ensureAccount(access.clientId);
    const requiredPlanId = minimumPlanForPayload(payload);
    const creditCost = creditCostForPlan(requiredPlanId);
    const balance = getCreditBalanceUnits(access.clientId);
    if (balance < creditCost) {
      sendJson(response, 402, {
        error: `积分不足，当前余额 ${formatCredits(balance)}，本次需要 ${formatCredits(creditCost)} 积分。`,
        credits: accountSummary(access.clientId).credits,
        requiredCredits: Number(formatCredits(creditCost)),
      });
      return;
    }

    const taskId = `task_${randomUUID().replaceAll("-", "")}`;
    const assets = await saveEmbeddedImages(taskId, payload);
    const storedResponse = makeStoredResponse(taskId, payload, assets);
    insertTask(taskId, payload, storedResponse, assets, {
      clientId: access.clientId,
      amountUnits: creditCost,
      reason: `${requiredPlanId}_generation`,
    });
    storedResponse.credits = accountSummary(access.clientId).credits;
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

function handleListTasks(request, requestUrl, response) {
  const limit = Math.min(Number(requestUrl.searchParams.get("limit") || 20), 100);
  const clientId = getClientId(request);
  if (!clientId) {
    sendError(response, 400, "Missing X-Client-Id");
    return;
  }

  const tasks = [...store.tasks.values()]
    .filter((task) => task.clientId === clientId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit)
    .map(taskToJson);

  sendJson(response, 200, { tasks });
}

function handleGetTask(request, taskId, response) {
  const clientId = getClientId(request);
  if (!clientId) {
    sendError(response, 400, "Missing X-Client-Id");
    return;
  }

  const task = store.tasks.get(taskId);
  if (!task || task.clientId !== clientId) {
    sendError(response, 404, "Task not found");
    return;
  }

  const assets = [...store.assets.values()]
    .filter((asset) => asset.taskId === taskId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  sendJson(response, 200, { ...taskToJson(task), assets });
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
      "Access-Control-Allow-Headers": "Content-Type, X-Client-Id",
    });
    response.end();
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      storage: "memory",
      persistent: false,
    });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/plans") {
    handleListPlans(response);
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/entitlement") {
    handleCurrentEntitlement(request, response);
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/account") {
    handleGetAccount(request, response);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/referrals") {
    await handleApplyReferral(request, response);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/payments") {
    await handleCreatePayment(request, response);
    return;
  }

  if (request.method === "POST" && /^\/api\/payments\/[^/]+\/confirm$/.test(requestUrl.pathname)) {
    await handleConfirmPayment(request, response);
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/tasks") {
    handleListTasks(request, requestUrl, response);
    return;
  }

  if (request.method === "GET" && requestUrl.pathname.startsWith("/api/tasks/")) {
    handleGetTask(request, requestUrl.pathname.split("/").pop(), response);
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
    console.log("Storage: memory (replace this layer when connecting your database)");
  });
});
