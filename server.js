const express = require("express");
const nodemailer = require("nodemailer");
const { writeFile, mkdir } = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");
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
const EMAIL_CODE_TTL_MS = 5 * 60 * 1000;
const EMAIL_CODE_RESEND_WINDOW_MS = 60 * 1000;
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
  response
    .status(statusCode)
    .set({
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Client-Id, X-Auth-Token, Authorization",
      ...securityHeaders(),
    })
    .json(data);
}

function sendNoContent(response) {
  response.status(204).set({
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Client-Id, X-Auth-Token, Authorization",
    ...securityHeaders(),
  }).end();
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

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function validateEmail(email) {
  const normalized = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalized) || normalized.length > 254) {
    return "请输入有效的邮箱地址。";
  }
  return null;
}

function makeEmailCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function hashEmailCode(email, code) {
  const secret = process.env.EMAIL_CODE_SECRET;
  if (!secret) {
    throw new Error("EMAIL_CODE_SECRET is not configured");
  }
  return createHash("sha256").update(`${secret}:${normalizeEmail(email)}:${code}`).digest("hex");
}

function createMailTransporter() {
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: process.env.SMTP_USER || process.env.SMTP_PASS
      ? {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        }
      : undefined,
  });
}

async function sendLoginCodeEmail(email, code, purpose) {
  if (!process.env.SMTP_HOST || !process.env.MAIL_FROM) {
    throw new Error("SMTP_HOST and MAIL_FROM must be configured");
  }
  const subject = purpose === "password_reset" ? "ImgBest 重置密码验证码" : "ImgBest 注册验证码";
  const transporter = createMailTransporter();
  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: email,
    subject,
    text: `您的 ${subject} 是：${code}\n\n验证码 5 分钟内有效，请勿泄露给他人。`,
    html: `<p>您的 ${subject} 是：</p><p style="font-size:24px;font-weight:700;letter-spacing:4px;">${code}</p><p>验证码 5 分钟内有效，请勿泄露给他人。</p>`,
  });
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
    email: account.email,
    isRegistered: Boolean(account.username || account.email),
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
    const payload = request.body || {};
    const username = normalizeUsername(payload.username);
    const email = normalizeEmail(payload.email);
    const code = String(payload.code || "").trim();
    const credentialError = validateCredentials(username, payload.password);
    if (credentialError) {
      sendError(response, 400, credentialError);
      return;
    }
    const emailError = validateEmail(email);
    if (emailError) {
      sendError(response, 400, emailError);
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      sendError(response, 400, "验证码错误或已过期。");
      return;
    }

    const requestedClientId = getClientId(request) || `client_${randomUUID().replaceAll("-", "")}`;
    const existingUsername = await prisma.account.findUnique({ where: { username } });
    if (existingUsername) {
      sendError(response, 409, "该账号已被注册。");
      return;
    }
    const existingEmail = await prisma.account.findUnique({ where: { email } });
    if (existingEmail) {
      sendError(response, 409, "该邮箱已注册，请直接登录或找回密码。");
      return;
    }
    const passwordParts = await hashPassword(payload.password);
    const verifiedCode = await verifyEmailCode(email, code, "register");
    if (verifiedCode.error) {
      sendError(response, verifiedCode.statusCode, verifiedCode.error);
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
      const usernameOwner = await tx.account.findUnique({ where: { username } });
      if (usernameOwner) return { error: "该账号已被注册。" };
      const emailOwner = await tx.account.findUnique({ where: { email } });
      if (emailOwner) return { error: "该邮箱已注册，请直接登录或找回密码。" };

      const existing = await tx.account.findUnique({ where: { clientId: requestedClientId } });
      const clientId = existing ? `client_${randomUUID().replaceAll("-", "")}` : requestedClientId;
      const account = await tx.account.create({
        data: {
          clientId,
          inviteCode: await makeUniqueInviteCode(tx),
          username,
          email,
          passwordHash: passwordParts.passwordHash,
          passwordSalt: passwordParts.passwordSalt,
        },
      });
      await tx.emailLoginCode.update({
        where: { id: verifiedCode.codeId },
        data: { usedAt: new Date() },
      });
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
    const payload = request.body || {};
    const identifier = String(payload.identifier || payload.username || "").trim().toLowerCase();
    if (!identifier || typeof payload.password !== "string") {
      sendError(response, 400, "请输入账号或邮箱和密码。");
      return;
    }

    const account = identifier.includes("@")
      ? await prisma.account.findUnique({ where: { email: normalizeEmail(identifier) } })
      : await prisma.account.findUnique({ where: { username: normalizeUsername(identifier) } });
    const isValid = account ? await verifyPassword(payload.password, account.passwordSalt, account.passwordHash) : false;
    if (!isValid) {
      sendError(response, 401, "账号/邮箱或密码错误。");
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

async function handleSendEmailCode(request, response) {
  try {
    const payload = request.body || {};
    const email = normalizeEmail(payload.email);
    const purpose = String(payload.purpose || "").trim();
    const emailError = validateEmail(email);
    if (emailError) {
      sendError(response, 400, emailError);
      return;
    }
    if (!["register", "password_reset"].includes(purpose)) {
      sendError(response, 400, "Unknown email code purpose");
      return;
    }
    const account = await prisma.account.findUnique({ where: { email } });
    if (purpose === "register" && account) {
      sendError(response, 409, "该邮箱已注册，请直接登录或找回密码。");
      return;
    }
    if (purpose === "password_reset" && !account) {
      sendError(response, 404, "该邮箱尚未注册。");
      return;
    }

    const recentCode = await prisma.emailLoginCode.findFirst({
      where: {
        email,
        purpose,
        createdAt: {
          gte: new Date(Date.now() - EMAIL_CODE_RESEND_WINDOW_MS),
        },
      },
      orderBy: { createdAt: "desc" },
    });
    if (recentCode) {
      sendError(response, 429, "同一邮箱 60 秒内不能重复发送验证码。");
      return;
    }

    const code = makeEmailCode();
    await prisma.emailLoginCode.create({
      data: {
        id: `email_code_${randomUUID().replaceAll("-", "")}`,
        email,
        purpose,
        codeHash: hashEmailCode(email, code),
        expiresAt: new Date(Date.now() + EMAIL_CODE_TTL_MS),
      },
    });

    await sendLoginCodeEmail(email, code, purpose);
    sendJson(response, 200, {
      ok: true,
      message: "验证码已发送",
    });
  } catch (error) {
    sendError(response, 500, error.message);
  }
}

function isSameHash(expectedHash, actualHash) {
  const expected = Buffer.from(expectedHash, "hex");
  const actual = Buffer.from(actualHash, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function verifyEmailCode(email, code, purpose) {
  if (!/^\d{6}$/.test(String(code || "").trim())) {
    return { ok: false, statusCode: 400, error: "验证码错误或已过期。" };
  }
  const loginCode = await prisma.emailLoginCode.findFirst({
    where: {
      email,
      purpose,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!loginCode) return { ok: false, statusCode: 400, error: "验证码错误或已过期。" };
  if (loginCode.attempts >= 5) {
    return { ok: false, statusCode: 429, error: "验证码尝试次数过多，请重新获取。" };
  }
  if (!isSameHash(loginCode.codeHash, hashEmailCode(email, code))) {
    await prisma.emailLoginCode.update({
      where: { id: loginCode.id },
      data: { attempts: { increment: 1 } },
    });
    return { ok: false, statusCode: 400, error: "验证码错误或已过期。" };
  }
  return { ok: true, codeId: loginCode.id };
}

function handleEmailCodeLogin(request, response) {
  sendJson(response, 410, {
    error: "邮箱验证码登录已停用，请使用账号或邮箱加密码登录。",
  });
}

async function handlePasswordReset(request, response) {
  try {
    const payload = request.body || {};
    const email = normalizeEmail(payload.email);
    const code = String(payload.code || "").trim();
    const emailError = validateEmail(email);
    if (emailError) {
      sendError(response, 400, emailError);
      return;
    }
    if (typeof payload.password !== "string" || payload.password.length < 8 || payload.password.length > 80) {
      sendError(response, 400, "密码长度需要 8-80 位。");
      return;
    }

    const account = await prisma.account.findUnique({ where: { email } });
    if (!account) {
      sendError(response, 404, "该邮箱尚未注册。");
      return;
    }
    const verifiedCode = await verifyEmailCode(email, code, "password_reset");
    if (verifiedCode.error) {
      sendError(response, verifiedCode.statusCode, verifiedCode.error);
      return;
    }

    const passwordParts = await hashPassword(payload.password);
    await prisma.$transaction(async (tx) => {
      await tx.emailLoginCode.update({
        where: { id: verifiedCode.codeId },
        data: { usedAt: new Date() },
      });
      await tx.account.update({
        where: { clientId: account.clientId },
        data: {
          passwordHash: passwordParts.passwordHash,
          passwordSalt: passwordParts.passwordSalt,
        },
      });
      await tx.authSession.deleteMany({ where: { clientId: account.clientId } });
    });

    sendJson(response, 200, {
      ok: true,
      message: "密码已重置，请重新登录。",
    });
  } catch (error) {
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
    const payload = request.body || {};
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

    const payload = request.body || {};
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

  const paymentId = request.params.paymentId;
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
    const payload = request.body || {};
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

async function handleListTasks(request, response) {
  const limit = Math.min(Number(request.query.limit || 20), 100);
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

function asyncRoute(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

function applySecurityHeaders(request, response, next) {
  response.set(securityHeaders());
  next();
}

function applyCors(request, response, next) {
  response.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Client-Id, X-Auth-Token, Authorization",
  });
  if (request.method === "OPTIONS") {
    sendNoContent(response);
    return;
  }
  next();
}

function apiGuard(request, response, next) {
  const isPublicApiRequest =
    request.path === "/health" ||
    request.path === "/plans" ||
    request.path.startsWith("/auth/");

  if (isRateLimited(request, "api", API_RATE_LIMIT)) {
    sendError(response, 429, "请求过于频繁，请稍后再试。");
    return;
  }

  if (!isPublicApiRequest && isSuspiciousCrawler(request)) {
    sendError(response, 403, "Forbidden");
    return;
  }

  next();
}

ensureStorage().then(() => {
  const app = express();

  app.disable("x-powered-by");
  app.use(applySecurityHeaders);
  app.use(applyCors);
  app.use(express.json({ limit: MAX_BODY_SIZE }));

  app.get("/robots.txt", (request, response) => {
    response
      .status(200)
      .type("text/plain; charset=utf-8")
      .set(securityHeaders({ "Cache-Control": "public, max-age=3600" }))
      .send("User-agent: *\nDisallow: /\n");
  });

  const api = express.Router();
  api.use(apiGuard);
  api.post(["/auth/register", "/auth/login", "/auth/email-code/send", "/auth/email-code/login", "/auth/password-reset"], (request, response, next) => {
    if (isRateLimited(request, "auth", AUTH_RATE_LIMIT)) {
      sendError(response, 429, "登录尝试过于频繁，请稍后再试。");
      return;
    }
    next();
  });
  api.get("/health", asyncRoute((request, response) => handleHealth(response)));
  api.get("/plans", (request, response) => handleListPlans(response));
  api.post("/auth/register", asyncRoute(handleRegister));
  api.post("/auth/login", asyncRoute(handleLogin));
  api.post("/auth/email-code/send", asyncRoute(handleSendEmailCode));
  api.post("/auth/email-code/login", asyncRoute(handleEmailCodeLogin));
  api.post("/auth/password-reset", asyncRoute(handlePasswordReset));
  api.post("/auth/logout", asyncRoute(handleLogout));
  api.get("/entitlement", asyncRoute(handleCurrentEntitlement));
  api.get("/account", asyncRoute(handleGetAccount));
  api.post("/referrals", asyncRoute(handleApplyReferral));
  api.post("/payments", asyncRoute(handleCreatePayment));
  api.post("/payments/:paymentId/confirm", asyncRoute(handleConfirmPayment));
  api.get("/tasks", asyncRoute(handleListTasks));
  api.get("/tasks/:taskId", asyncRoute((request, response) => handleGetTask(request, request.params.taskId, response)));
  api.post("/generate-image", asyncRoute(handleGenerateImage));
  api.use((request, response) => sendError(response, 404, "Not found"));

  app.use("/api", api);

  app.get("/", (request, response) => {
    response.set(securityHeaders({ "Cache-Control": "no-store" }));
    response.sendFile(path.join(ROOT, "index.html"));
  });

  app.use(
    express.static(ROOT, {
      dotfiles: "deny",
      index: false,
      maxAge: "1h",
      setHeaders(response, filePath) {
        const cacheControl = path.extname(filePath).toLowerCase() === ".html" ? "no-store" : "public, max-age=3600";
        response.set(securityHeaders({ "Cache-Control": cacheControl }));
      },
    }),
  );

  app.use((request, response) => sendError(response, request.method === "GET" ? 404 : 405, request.method === "GET" ? "Not found" : "Method not allowed"));

  app.use((error, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    if (error instanceof SyntaxError || error.type === "entity.parse.failed") {
      sendError(response, 400, "Invalid JSON body");
      return;
    }
    if (error.type === "entity.too.large") {
      sendError(response, 413, "Request body is too large");
      return;
    }
    sendError(response, 500, error.message);
  });

  app.listen(PORT, "127.0.0.1", () => {
    console.log(`ImgBest server running at http://127.0.0.1:${PORT}`);
    console.log("Storage: PostgreSQL via Prisma");
  });
});
