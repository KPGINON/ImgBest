const { createServer } = require("node:http");
const { readFile, stat, writeFile, mkdir } = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");
const { URL } = require("node:url");
const { prisma } = require("./src/db");

const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, "uploads");
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_SIZE = 40 * 1024 * 1024;
const SESSION_TTL_DAYS = 14;
const PASSWORD_KEY_LENGTH = 64;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const API_RATE_LIMIT = 120;
const AUTH_RATE_LIMIT = 12;
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

const scryptAsync = promisify(scrypt);
const rateBuckets = new Map();

async function ensureStorage() {
  await mkdir(UPLOAD_DIR, { recursive: true });
}

function securityHeaders(extra = {}) {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    ...extra,
  };
}

function sendJson(response, statusCode, data) {
  const body = Buffer.from(JSON.stringify(data, null, 2));
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Client-Id, X-Auth-Token, Authorization",
    ...securityHeaders(),
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

function getRequestIp(request) {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
  return request.socket.remoteAddress || "unknown";
}

function getAuthToken(request) {
  const headerToken = request.headers["x-auth-token"];
  if (typeof headerToken === "string" && headerToken.trim()) return headerToken.trim();

  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  return null;
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

function validateCredentials(username, password) {
  const normalized = normalizeUsername(username);
  if (!/^[a-z0-9_@.-]{3,40}$/.test(normalized)) {
    return "账号只能包含字母、数字、下划线、点、横线或 @，长度 3-40 位。";
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 80) {
    return "密码长度需要 8-80 位。";
  }
  return null;
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = await scryptAsync(password, salt, PASSWORD_KEY_LENGTH);
  return { passwordSalt: salt, passwordHash: hash.toString("hex") };
}

async function verifyPassword(password, passwordSalt, passwordHash) {
  if (!passwordSalt || !passwordHash) return false;
  const expected = Buffer.from(passwordHash, "hex");
  const actual = await scryptAsync(password, passwordSalt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function isRateLimited(request, scope, limit) {
  const key = `${scope}:${getRequestIp(request)}`;
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > limit;
}

function isSuspiciousCrawler(request) {
  const userAgent = String(request.headers["user-agent"] || "").toLowerCase();
  if (!userAgent) return true;
  return /(python-requests|scrapy|httpclient|curl|wget|libwww|go-http-client|java\/|aiohttp)/.test(userAgent);
}

function formatCredits(units) {
  const value = units / CREDIT_SCALE;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function makeInviteCode() {
  return `IB${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
}

async function makeUniqueInviteCode(client = prisma) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const inviteCode = makeInviteCode();
    const used = await client.account.findUnique({ where: { inviteCode } });
    if (!used) return inviteCode;
  }
  throw new Error("Unable to create a unique invite code");
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
      provider: "postgresql",
      imageUrl: publicAssetForRole(assets, "modelImage") || "/assets/hero-bag-model.png",
      assets,
      message: "换包任务已写入数据库。接入 ComfyUI 后可返回真实生成图。",
    };
  }

  const variantPrompts = payload.variantPrompts?.length ? payload.variantPrompts : [payload.prompt || ""];
  return {
    id: taskId,
    status: "stored",
    provider: "postgresql",
    imageUrl: "/assets/hero-bag-model.png",
    variants: variantPrompts.map((prompt, index) => ({
      id: `v${index + 1}`,
      imageUrl: "/assets/hero-bag-model.png",
      prompt,
    })),
    assets,
    message: "商品图任务已写入数据库。接入 ComfyUI 后可返回真实生成图。",
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

function assetToJson(asset) {
  return {
    id: asset.id,
    taskId: asset.taskId,
    role: asset.role,
    originalName: asset.originalName,
    mimeType: asset.mimeType,
    filePath: asset.filePath,
    publicUrl: asset.publicUrl,
    sizeBytes: asset.sizeBytes,
    createdAt: asset.createdAt,
  };
}

function toPrismaJson(value) {
  return JSON.parse(JSON.stringify(value));
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

function accountToJson(account) {
  if (!account) return null;
  return {
    clientId: account.clientId,
    username: account.username,
    isRegistered: Boolean(account.username),
    inviteCode: account.inviteCode,
    referredBy: account.referredBy,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

async function getEntitlement(clientId, client = prisma) {
  if (!clientId) return null;
  const entitlement = await client.entitlement.findUnique({ where: { clientId } });
  return entitlementToJson(entitlement);
}

async function ensureAccount(clientId, client = prisma) {
  if (!clientId) return null;
  const existing = await client.account.findUnique({ where: { clientId } });
  if (existing) return accountToJson(existing);

  const account = await client.account.create({
    data: {
      clientId,
      inviteCode: await makeUniqueInviteCode(client),
    },
  });
  return accountToJson(account);
}

async function createSession(account, request, client = prisma) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await client.authSession.create({
    data: {
      id: `sess_${randomUUID().replaceAll("-", "")}`,
      clientId: account.clientId,
      tokenHash: hashToken(token),
      userAgent: String(request.headers["user-agent"] || "").slice(0, 300),
      ipAddress: getRequestIp(request).slice(0, 80),
      expiresAt,
    },
  });
  return { token, expiresAt };
}

async function authenticateRequest(request) {
  const clientId = getClientId(request);
  const token = getAuthToken(request);
  if (!clientId || !token) return null;

  const session = await prisma.authSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { account: true },
  });
  if (!session || session.clientId !== clientId || session.expiresAt <= new Date()) {
    return null;
  }
  return accountToJson(session.account);
}

async function requireAuthenticatedAccount(request, response) {
  const account = await authenticateRequest(request);
  if (!account) {
    sendJson(response, 401, { error: "请先登录后再操作。" });
    return null;
  }
  return account;
}

async function handleRegister(request, response) {
  try {
    const payload = await readJsonBody(request);
    const username = normalizeUsername(payload.username);
    const credentialError = validateCredentials(username, payload.password);
    if (credentialError) {
      sendError(response, 400, credentialError);
      return;
    }

    const requestedClientId = getClientId(request) || `client_${randomUUID().replaceAll("-", "")}`;
    const passwordParts = await hashPassword(payload.password);
    const result = await prisma.$transaction(async (tx) => {
      const usernameOwner = await tx.account.findUnique({ where: { username } });
      if (usernameOwner) return { error: "该账号已被注册。" };

      const existing = await tx.account.findUnique({ where: { clientId: requestedClientId } });
      let account;
      if (existing) {
        if (existing.username && existing.username !== username) return { error: "当前浏览器账户已绑定其他账号。" };
        account = await tx.account.update({
          where: { clientId: requestedClientId },
          data: {
            username,
            passwordHash: passwordParts.passwordHash,
            passwordSalt: passwordParts.passwordSalt,
          },
        });
      } else {
        account = await tx.account.create({
          data: {
            clientId: requestedClientId,
            inviteCode: await makeUniqueInviteCode(tx),
            username,
            passwordHash: passwordParts.passwordHash,
            passwordSalt: passwordParts.passwordSalt,
          },
        });
      }
      return { account };
    });

    if (result.error) {
      sendError(response, 409, result.error);
      return;
    }

    const session = await createSession(result.account, request);
    sendJson(response, 201, {
      auth: { token: session.token, expiresAt: session.expiresAt, clientId: result.account.clientId },
      account: await accountSummary(result.account.clientId),
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      sendError(response, 400, "Invalid JSON body");
      return;
    }
    sendError(response, 500, error.message);
  }
}

async function handleLogin(request, response) {
  try {
    const payload = await readJsonBody(request);
    const username = normalizeUsername(payload.username);
    if (!username || typeof payload.password !== "string") {
      sendError(response, 400, "请输入账号和密码。");
      return;
    }

    const account = await prisma.account.findUnique({ where: { username } });
    const isValid = account ? await verifyPassword(payload.password, account.passwordSalt, account.passwordHash) : false;
    if (!isValid) {
      sendError(response, 401, "账号或密码错误。");
      return;
    }

    const session = await createSession(account, request);
    sendJson(response, 200, {
      auth: { token: session.token, expiresAt: session.expiresAt, clientId: account.clientId },
      account: await accountSummary(account.clientId),
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      sendError(response, 400, "Invalid JSON body");
      return;
    }
    sendError(response, 500, error.message);
  }
}

async function handleLogout(request, response) {
  const token = getAuthToken(request);
  if (token) {
    await prisma.authSession.deleteMany({ where: { tokenHash: hashToken(token) } });
  }
  sendJson(response, 200, { ok: true });
}

async function getCreditBalanceUnits(clientId, client = prisma) {
  if (!clientId) return 0;
  const result = await client.creditLedger.aggregate({
    where: { clientId },
    _sum: { amountUnits: true },
  });
  return result._sum.amountUnits || 0;
}

async function addCreditEntry(clientId, amountUnits, reason, referenceId = null, client = prisma) {
  await ensureAccount(clientId, client);
  return client.creditLedger.create({
    data: {
      id: `credit_${randomUUID().replaceAll("-", "")}`,
      clientId,
      amountUnits: Math.round(amountUnits),
      reason,
      referenceId,
    },
  });
}

async function getRecentCreditLedger(clientId, limit = 8, client = prisma) {
  const entries = await client.creditLedger.findMany({
    where: { clientId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return entries.map((entry) => ({
    id: entry.id,
    amountUnits: entry.amountUnits,
    amountCredits: Number(formatCredits(entry.amountUnits)),
    reason: entry.reason,
    referenceId: entry.referenceId,
    createdAt: entry.createdAt,
  }));
}

async function accountSummary(clientId, client = prisma) {
  const account = await ensureAccount(clientId, client);
  const balanceUnits = await getCreditBalanceUnits(clientId, client);
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
    ledger: await getRecentCreditLedger(clientId, 8, client),
  };
}

async function applyReferral(clientId, inviteCode) {
  const account = await ensureAccount(clientId);
  if (!inviteCode || account.referredBy) return accountSummary(clientId);

  const inviter = await prisma.account.findUnique({
    where: { inviteCode: String(inviteCode).trim() },
  });
  if (!inviter || inviter.clientId === clientId) return accountSummary(clientId);

  await prisma.$transaction(async (tx) => {
    const updated = await tx.account.updateMany({
      where: { clientId, referredBy: null },
      data: { referredBy: inviter.clientId },
    });
    if (updated.count > 0) {
      await addCreditEntry(inviter.clientId, INVITE_REWARD_CREDITS, "invite_reward", clientId, tx);
    }
  });

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

async function handleCurrentEntitlement(request, response) {
  const account = await requireAuthenticatedAccount(request, response);
  if (!account) return;
  const clientId = account.clientId;
  sendJson(response, 200, {
    entitlement: await getEntitlement(clientId),
    account: await accountSummary(clientId),
  });
}

async function handleGetAccount(request, response) {
  const account = await requireAuthenticatedAccount(request, response);
  if (!account) return;
  sendJson(response, 200, await accountSummary(account.clientId));
}

async function handleApplyReferral(request, response) {
  try {
    const account = await requireAuthenticatedAccount(request, response);
    if (!account) return;
    const payload = await readJsonBody(request);
    sendJson(response, 200, await applyReferral(account.clientId, payload.inviteCode));
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
    const account = await requireAuthenticatedAccount(request, response);
    if (!account) return;
    const clientId = account.clientId;

    const payload = await readJsonBody(request);
    const plan = PLAN_CONFIGS[payload.planId];
    const creditPack = CREDIT_PACKS[payload.packId];
    if (!plan && !creditPack) {
      sendError(response, 400, "Unknown planId or packId");
      return;
    }
    await ensureAccount(clientId);
    const paymentTarget = creditPack || plan;

    const paymentId = `pay_${randomUUID().replaceAll("-", "")}`;
    await prisma.payment.create({
      data: {
        id: paymentId,
        clientId,
        planId: paymentTarget.id,
        amountCents: paymentTarget.amountCents,
        status: "pending",
      },
    });

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
  const account = await requireAuthenticatedAccount(request, response);
  if (!account) return;
  const clientId = account.clientId;

  const paymentId = request.url.split("/").at(-2);
  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, clientId },
  });
  if (!payment) {
    sendError(response, 404, "Payment not found");
    return;
  }

  const plan = PLAN_CONFIGS[payment.planId];
  const creditPack = CREDIT_PACKS[payment.planId];
  if (!plan && !creditPack) {
    sendError(response, 400, "Payment plan is invalid");
    return;
  }

  const confirmedPayment = await prisma.$transaction(async (tx) => {
    if (payment.status === "paid") return payment;

    const paidAt = new Date();
    const updatedPayment = await tx.payment.update({
      where: { id: paymentId },
      data: { status: "paid", paidAt },
    });

    if (plan) {
      await tx.entitlement.upsert({
        where: { clientId },
        create: {
          clientId,
          planId: plan.id,
          paymentId,
          startsAt: paidAt,
        },
        update: {
          planId: plan.id,
          paymentId,
          startsAt: paidAt,
          expiresAt: null,
        },
      });
      await addCreditEntry(clientId, plan.amountCents / 10, "payment_credit", paymentId, tx);
    } else {
      await addCreditEntry(clientId, creditPack.creditUnits, "credit_recharge", paymentId, tx);
    }

    return updatedPayment;
  });

  sendJson(response, 200, {
    payment: paymentToJson(confirmedPayment),
    entitlement: await getEntitlement(clientId),
    account: await accountSummary(clientId),
  });
}

async function insertTaskWithCreditCharge(taskId, payload, response, assets, creditCharge) {
  return prisma.$transaction(async (tx) => {
    await ensureAccount(creditCharge.clientId, tx);
    const balance = await getCreditBalanceUnits(creditCharge.clientId, tx);
    if (balance < creditCharge.amountUnits) {
      return { ok: false, balance };
    }

    const assetCreates = assets.map((asset) => ({
      id: asset.id,
      role: asset.role,
      originalName: asset.originalName,
      mimeType: asset.mimeType,
      filePath: asset.filePath,
      publicUrl: asset.publicUrl,
      sizeBytes: asset.sizeBytes,
    }));

    await tx.task.create({
      data: {
        id: taskId,
        clientId: creditCharge.clientId,
        workflow: payload.workflow || "unknown",
        status: response.status || "stored",
        prompt: payload.prompt || "",
        payload: toPrismaJson(payload),
        response: toPrismaJson(response),
        ...(assetCreates.length ? { assets: { create: assetCreates } } : {}),
      },
    });

    await addCreditEntry(creditCharge.clientId, -creditCharge.amountUnits, creditCharge.reason, taskId, tx);
    return { ok: true, balance: balance - creditCharge.amountUnits };
  });
}

async function handleGenerateImage(request, response) {
  try {
    const payload = await readJsonBody(request);
    const access = assertPlanAccess(request, payload);
    const account = await requireAuthenticatedAccount(request, response);
    if (!account) return;
    access.clientId = account.clientId;

    await ensureAccount(access.clientId);
    const requiredPlanId = minimumPlanForPayload(payload);
    const creditCost = creditCostForPlan(requiredPlanId);
    const balance = await getCreditBalanceUnits(access.clientId);
    if (balance < creditCost) {
      sendJson(response, 402, {
        error: `积分不足，当前余额 ${formatCredits(balance)}，本次需要 ${formatCredits(creditCost)} 积分。`,
        credits: (await accountSummary(access.clientId)).credits,
        requiredCredits: Number(formatCredits(creditCost)),
      });
      return;
    }

    const taskId = `task_${randomUUID().replaceAll("-", "")}`;
    const assets = await saveEmbeddedImages(taskId, payload);
    const storedResponse = makeStoredResponse(taskId, payload, assets);
    const inserted = await insertTaskWithCreditCharge(taskId, payload, storedResponse, assets, {
      clientId: access.clientId,
      amountUnits: creditCost,
      reason: `${requiredPlanId}_generation`,
    });

    if (!inserted.ok) {
      sendJson(response, 402, {
        error: `积分不足，当前余额 ${formatCredits(inserted.balance)}，本次需要 ${formatCredits(creditCost)} 积分。`,
        credits: (await accountSummary(access.clientId)).credits,
        requiredCredits: Number(formatCredits(creditCost)),
      });
      return;
    }

    storedResponse.credits = (await accountSummary(access.clientId)).credits;
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

async function handleListTasks(request, requestUrl, response) {
  const limit = Math.min(Number(requestUrl.searchParams.get("limit") || 20), 100);
  const account = await requireAuthenticatedAccount(request, response);
  if (!account) return;
  const clientId = account.clientId;

  const tasks = await prisma.task.findMany({
    where: { clientId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  sendJson(response, 200, { tasks: tasks.map(taskToJson) });
}

async function handleGetTask(request, taskId, response) {
  const account = await requireAuthenticatedAccount(request, response);
  if (!account) return;
  const clientId = account.clientId;

  const task = await prisma.task.findFirst({
    where: { id: taskId, clientId },
    include: {
      assets: {
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!task) {
    sendError(response, 404, "Task not found");
    return;
  }

  sendJson(response, 200, { ...taskToJson(task), assets: task.assets.map(assetToJson) });
}

async function serveStatic(requestUrl, response) {
  const requestedPath = decodeURIComponent(requestUrl.pathname);
  const relativePath = requestedPath === "/" ? "index.html" : requestedPath.slice(1);
  if (relativePath.startsWith(".") || relativePath.includes("/.")) {
    sendError(response, 404, "Not found");
    return;
  }

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
      ...securityHeaders({
        "Cache-Control": path.extname(filePath).toLowerCase() === ".html" ? "no-store" : "public, max-age=3600",
      }),
    });
    response.end(body);
  } catch {
    sendError(response, 404, "Not found");
  }
}

async function handleHealth(response) {
  try {
    await prisma.$queryRaw`SELECT 1`;
    sendJson(response, 200, {
      ok: true,
      storage: "postgresql",
      persistent: true,
    });
  } catch (error) {
    sendJson(response, 503, {
      ok: false,
      storage: "postgresql",
      persistent: true,
      error: error.message,
    });
  }
}

async function route(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const isApiRequest = requestUrl.pathname.startsWith("/api/");
  const isPublicApiRequest =
    requestUrl.pathname === "/api/health" ||
    requestUrl.pathname === "/api/plans" ||
    requestUrl.pathname.startsWith("/api/auth/");

  if (isApiRequest && isRateLimited(request, "api", API_RATE_LIMIT)) {
    sendError(response, 429, "请求过于频繁，请稍后再试。");
    return;
  }

  if (isApiRequest && !isPublicApiRequest && isSuspiciousCrawler(request)) {
    sendError(response, 403, "Forbidden");
    return;
  }

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Client-Id, X-Auth-Token, Authorization",
      ...securityHeaders(),
    });
    response.end();
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/robots.txt") {
    const body = Buffer.from("User-agent: *\nDisallow: /\n");
    response.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": body.length,
      ...securityHeaders({ "Cache-Control": "public, max-age=3600" }),
    });
    response.end(body);
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/health") {
    await handleHealth(response);
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/plans") {
    handleListPlans(response);
    return;
  }

  if (request.method === "POST" && (requestUrl.pathname === "/api/auth/register" || requestUrl.pathname === "/api/auth/login")) {
    if (isRateLimited(request, "auth", AUTH_RATE_LIMIT)) {
      sendError(response, 429, "登录尝试过于频繁，请稍后再试。");
      return;
    }
    if (requestUrl.pathname === "/api/auth/register") {
      await handleRegister(request, response);
    } else {
      await handleLogin(request, response);
    }
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/auth/logout") {
    await handleLogout(request, response);
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/entitlement") {
    await handleCurrentEntitlement(request, response);
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/account") {
    await handleGetAccount(request, response);
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
    await handleListTasks(request, requestUrl, response);
    return;
  }

  if (request.method === "GET" && requestUrl.pathname.startsWith("/api/tasks/")) {
    await handleGetTask(request, requestUrl.pathname.split("/").pop(), response);
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
    console.log("Storage: PostgreSQL via Prisma");
  });
});
