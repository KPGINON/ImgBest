const COMFYUI_ENDPOINT = "/api/generate-image";
const MOCK_IMAGE_URL = "./assets/hero-bag-model.png";
const STORAGE_KEY = "imgbest-generation-history";
const CLIENT_ID_KEY = "imgbest-client-id";
const AUTH_TOKEN_KEY = "imgbest-auth-token";
const PLAN_RANK = {
  basic: 1,
  pro: 2,
  premium: 3,
};
const PLAN_LABELS = {
  basic: "普通生成",
  pro: "正常生成",
  premium: "进阶生成",
};
const CREDIT_COSTS = {
  basic: 5,
  pro: 9.9,
  premium: 19.9,
};

const form = document.querySelector("#generationForm");
const statusPill = document.querySelector("#statusPill");
const loadingState = document.querySelector("#loadingState");
const resultImage = document.querySelector("#resultImage");
const promptPreview = document.querySelector("#promptPreview");
const taskId = document.querySelector("#taskId");
const payloadView = document.querySelector("#payloadView");
const variantStrip = document.querySelector("#variantStrip");
const historyList = document.querySelector("#historyList");
const clearHistory = document.querySelector("#clearHistory");
const exportPayload = document.querySelector("#exportPayload");
const promptScore = document.querySelector("#promptScore");
const scoreBar = document.querySelector("#scoreBar");
const customPromptInput = document.querySelector("#customPrompt");
const templateButtons = document.querySelectorAll(".template-card");
const replaceForm = document.querySelector("#replaceForm");
const uploadInputs = document.querySelectorAll("[data-upload]");
const replaceStatus = document.querySelector("#replaceStatus");
const replaceLoading = document.querySelector("#replaceLoading");
const replaceResult = document.querySelector("#replaceResult");
const replaceReadiness = document.querySelector("#replaceReadiness");
const exportReplacePayload = document.querySelector("#exportReplacePayload");
const qualityScore = document.querySelector("#qualityScore");
const qualityChecklist = document.querySelector("#qualityChecklist");
const pageLinks = document.querySelectorAll(".nav a, .nav-actions a, .hero-actions a");
const pages = document.querySelectorAll(".page");
const planButtons = document.querySelectorAll("[data-plan-id]");
const rechargeButtons = document.querySelectorAll("[data-pack-id]");
const currentPlan = document.querySelector("#currentPlan");
const paymentHint = document.querySelector("#paymentHint");
const refreshEntitlement = document.querySelector("#refreshEntitlement");
const confirmPayment = document.querySelector("#confirmPayment");
const generationAccess = document.querySelector("#generationAccess");
const replaceAccess = document.querySelector("#replaceAccess");
const creditBalance = document.querySelector("#creditBalance");
const creditHint = document.querySelector("#creditHint");
const inviteCode = document.querySelector("#inviteCode");
const inviteLink = document.querySelector("#inviteLink");
const referralCode = document.querySelector("#referralCode");
const applyReferral = document.querySelector("#applyReferral");
const profileCreditBalance = document.querySelector("#profileCreditBalance");
const profileCreditMeta = document.querySelector("#profileCreditMeta");
const profileInviteCode = document.querySelector("#profileInviteCode");
const profileInviteLink = document.querySelector("#profileInviteLink");
const profileClientId = document.querySelector("#profileClientId");
const profileTaskCount = document.querySelector("#profileTaskCount");
const ledgerList = document.querySelector("#ledgerList");
const profileTaskHistory = document.querySelector("#profileTaskHistory");
const refreshProfile = document.querySelector("#refreshProfile");
const refreshTaskHistory = document.querySelector("#refreshTaskHistory");
const authForm = document.querySelector("#authForm");
const emailAuthForm = document.querySelector("#emailAuthForm");
const authUsername = document.querySelector("#authUsername");
const authPassword = document.querySelector("#authPassword");
const authEmail = document.querySelector("#authEmail");
const authEmailCode = document.querySelector("#authEmailCode");
const authStatus = document.querySelector("#authStatus");
const authTabs = document.querySelectorAll("[data-auth-tab]");
const authTabPanels = document.querySelectorAll("[data-auth-panel]");
const authPasswordTab = document.querySelector("#authPasswordTab");
const authEmailTab = document.querySelector("#authEmailTab");
const authAccountSummary = document.querySelector("#authAccountSummary");
const authAccountName = document.querySelector("#authAccountName");
const authAccountCredits = document.querySelector("#authAccountCredits");
const loginButton = document.querySelector("#loginButton");
const registerButton = document.querySelector("#registerButton");
const sendEmailCodeButton = document.querySelector("#sendEmailCodeButton");
const emailLoginButton = document.querySelector("#emailLoginButton");
const logoutButton = document.querySelector("#logoutButton");
const navGuestActions = document.querySelector("#navGuestActions");
const navAccountActions = document.querySelector("#navAccountActions");
const navTopCredit = document.querySelector("#navTopCredit");

let selectedTemplate = document.querySelector(".template-card.is-active")?.dataset.template || "";
let latestPayload = null;
let latestReplacePayload = null;
let activeEntitlement = null;
let pendingPayment = null;
let accountState = null;
let activeAuthMethod = "password";
let emailCodeCountdown = 0;
let emailCodeTimer = null;
const replacementAssets = {
  bagFront: null,
  bagLeft45: null,
  bagRight45: null,
  bagTop: null,
  modelImage: null,
};

function getClientId() {
  let clientId = localStorage.getItem(CLIENT_ID_KEY);
  if (!clientId) {
    clientId = `client_${crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;
    localStorage.setItem(CLIENT_ID_KEY, clientId);
  }
  return clientId;
}

function requestHeaders() {
  const headers = {
    "Content-Type": "application/json",
    "X-Client-Id": getClientId(),
  };
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (token) headers["X-Auth-Token"] = token;
  return headers;
}

function isAuthenticated() {
  return Boolean(localStorage.getItem(AUTH_TOKEN_KEY));
}

function applyAuthPayload(data) {
  if (data.auth?.clientId) localStorage.setItem(CLIENT_ID_KEY, data.auth.clientId);
  if (data.auth?.token) localStorage.setItem(AUTH_TOKEN_KEY, data.auth.token);
  accountState = data.account || accountState;
  renderAuthState();
  updateAccessState();
}

function clearAuthState() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  accountState = null;
  activeEntitlement = null;
  pendingPayment = null;
  activeAuthMethod = "password";
  renderAuthState();
  updateAccessState();
  renderProfileTasks([]);
}

function accountDisplayName() {
  const account = accountState?.account;
  return account?.email || account?.username || account?.clientId || "";
}

function updateEmailCodeButton() {
  const loggedIn = isAuthenticated() && accountState?.account;
  sendEmailCodeButton.disabled = loggedIn || emailCodeCountdown > 0;
  sendEmailCodeButton.textContent = emailCodeCountdown > 0 ? `${emailCodeCountdown} 秒后重发` : "发送验证码";
}

function startEmailCodeCountdown() {
  emailCodeCountdown = 60;
  updateEmailCodeButton();
  if (emailCodeTimer) window.clearInterval(emailCodeTimer);
  emailCodeTimer = window.setInterval(() => {
    emailCodeCountdown -= 1;
    if (emailCodeCountdown <= 0) {
      emailCodeCountdown = 0;
      window.clearInterval(emailCodeTimer);
      emailCodeTimer = null;
    }
    updateEmailCodeButton();
  }, 1000);
}

function renderAuthState() {
  const loggedIn = isAuthenticated() && accountState?.account;
  authStatus.textContent = loggedIn
    ? `已登录：${accountDisplayName()}`
    : "注册或登录后才能充值、生成和查看历史。";
  navGuestActions.hidden = loggedIn;
  navAccountActions.hidden = !loggedIn;
  navTopCredit.textContent = `${creditBalanceValue().toFixed(1).replace(/\.0$/, "")} 积分`;
  authAccountSummary.hidden = !loggedIn;
  authAccountName.textContent = accountDisplayName() || "-";
  authAccountCredits.textContent = creditBalanceValue().toFixed(1).replace(/\.0$/, "");
  logoutButton.hidden = !loggedIn;
  loginButton.hidden = loggedIn;
  registerButton.hidden = loggedIn;
  authUsername.disabled = loggedIn;
  authPassword.disabled = loggedIn;
  authEmail.disabled = loggedIn;
  authEmailCode.disabled = loggedIn;
  emailLoginButton.hidden = loggedIn;
  authTabs.forEach((tab) => {
    tab.hidden = loggedIn;
    tab.classList.toggle("is-active", tab.dataset.authTab === activeAuthMethod);
  });
  authTabPanels.forEach((panel) => {
    const isActive = panel.dataset.authPanel === activeAuthMethod;
    panel.classList.toggle("is-active", isActive);
    panel.hidden = loggedIn || !isActive;
  });
  updateEmailCodeButton();
}

function setActiveAuthMethod(method) {
  activeAuthMethod = method === "email" ? "email" : "password";
  renderAuthState();
}

function hasPlan(requiredPlanId) {
  return true;
}

function creditBalanceValue() {
  return accountState?.credits?.balance || 0;
}

function hasCredits(requiredPlanId) {
  return creditBalanceValue() >= CREDIT_COSTS[requiredPlanId];
}

function requiredPlanForGeneration() {
  const deliveryTier = document.querySelector("#deliveryTier").value;
  const generationMode = document.querySelector("#generationMode").value;
  if (deliveryTier.startsWith("manual retouch review") || generationMode === "premium") return "premium";
  if (deliveryTier.includes("commercial-ready")) return "pro";
  return "basic";
}

function requiredPlanForReplacement() {
  return "pro";
}

function setAccessBanner(banner, isAllowed, text) {
  banner.textContent = text;
  banner.classList.toggle("is-allowed", isAllowed);
  banner.classList.toggle("is-blocked", !isAllowed);
}

function updateAccessState() {
  const loggedIn = isAuthenticated();
  const generationRequiredPlan = requiredPlanForGeneration();
  const replaceRequiredPlan = requiredPlanForReplacement();
  const canGenerateByPlan = hasPlan(generationRequiredPlan);
  const canReplaceByPlan = hasPlan(replaceRequiredPlan);
  const canGenerate = loggedIn && canGenerateByPlan && hasCredits(generationRequiredPlan);
  const canReplace = loggedIn && canReplaceByPlan && hasCredits(replaceRequiredPlan);

  form.querySelector(".submit-button").disabled = !canGenerate;
  exportPayload.disabled = !canGenerate;
  replaceForm.querySelector(".submit-button").disabled = !canReplace;
  exportReplacePayload.disabled = !canReplace;

  setAccessBanner(
    generationAccess,
    canGenerate,
    canGenerate
      ? `积分余额充足，本次将消耗 ${CREDIT_COSTS[generationRequiredPlan]} 积分。`
      : !loggedIn
        ? "请先登录账号，再提交生成任务。"
        : `当前生成配置需要 ${CREDIT_COSTS[generationRequiredPlan]} 积分，余额不足请先充值。`,
  );
  setAccessBanner(
    replaceAccess,
    canReplace,
    canReplace
      ? `积分余额充足，一键换包将消耗 ${CREDIT_COSTS[replaceRequiredPlan]} 积分。`
      : !loggedIn
        ? "请先登录账号，再使用一键换包。"
        : `一键换包需要 ${CREDIT_COSTS[replaceRequiredPlan]} 积分，余额不足请先充值。`,
  );

  currentPlan.textContent = "按次扣积分";
  if (!loggedIn) {
    paymentHint.textContent = "请先在个人主页注册或登录账号。";
  } else if (pendingPayment) {
    paymentHint.textContent = `订单 ${pendingPayment.id} 待确认，支付后可获得 ${pendingPayment.creditPack.creditGrant} 积分。`;
  } else {
    paymentHint.textContent = "充值后按生成模式扣积分：普通 5，正常 9.9，进阶 19.9。";
  }
  creditBalance.textContent = creditBalanceValue().toFixed(1).replace(/\.0$/, "");
  creditHint.textContent = `普通 ${CREDIT_COSTS.basic} 积分 / 正常 ${CREDIT_COSTS.pro} 积分 / 进阶 ${CREDIT_COSTS.premium} 积分。`;
  navTopCredit.textContent = `${creditBalanceValue().toFixed(1).replace(/\.0$/, "")} 积分`;
  authAccountCredits.textContent = creditBalanceValue().toFixed(1).replace(/\.0$/, "");

  if (accountState?.account) {
    const url = new URL(window.location.href);
    url.searchParams.set("ref", accountState.account.inviteCode);
    inviteCode.textContent = accountState.account.inviteCode;
    inviteLink.textContent = url.toString();
    renderProfileSummary(url.toString());
  }

  document.querySelectorAll("[data-plan-card]").forEach((card) => {
    const planId = card.dataset.planCard;
    const isOwned = activeEntitlement?.planId === planId;
    card.classList.toggle("is-owned", isOwned);
  });

  planButtons.forEach((button) => {
    const planId = button.dataset.planId;
    const isCurrent = activeEntitlement?.planId === planId;
    button.disabled = isCurrent;
    button.textContent = isCurrent ? "当前模式" : PLAN_LABELS[planId];
  });
}

function formatDateTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function reasonLabel(reason) {
  const labels = {
    credit_recharge: "充值到账",
    payment_credit: "积分充值",
    invite_reward: "邀请奖励",
    basic_generation: "普通生成",
    pro_generation: "正常生成",
    premium_generation: "进阶生成",
  };
  return labels[reason] || reason;
}

function renderProfileSummary(inviteUrl = "") {
  if (!accountState?.account) return;
  profileCreditBalance.textContent = creditBalanceValue().toFixed(1).replace(/\.0$/, "");
  profileCreditMeta.textContent = `普通 ${CREDIT_COSTS.basic} / 正常 ${CREDIT_COSTS.pro} / 进阶 ${CREDIT_COSTS.premium} 积分每次。`;
  profileInviteCode.textContent = accountState.account.inviteCode;
  profileInviteLink.textContent = inviteUrl || inviteLink.textContent || "-";
  profileClientId.textContent = getClientId();
  renderLedger(accountState.ledger || []);
}

function renderLedger(ledger) {
  if (!ledger.length) {
    ledgerList.innerHTML = '<p class="empty-state">暂无积分流水。</p>';
    return;
  }

  ledgerList.innerHTML = ledger
    .map((item) => {
      const amount = item.amountCredits > 0 ? `+${item.amountCredits}` : item.amountCredits;
      return `
        <article class="ledger-item ${item.amountCredits < 0 ? "is-negative" : ""}">
          <div>
            <span>${escapeHtml(reasonLabel(item.reason))}</span>
            <p>${escapeHtml(formatDateTime(item.createdAt))}</p>
          </div>
          <strong>${amount}</strong>
        </article>
      `;
    })
    .join("");
}

function imageForTask(task) {
  return task.response?.imageUrl || task.response?.variants?.[0]?.imageUrl || MOCK_IMAGE_URL;
}

function renderProfileTasks(tasks = []) {
  profileTaskCount.textContent = String(tasks.length);
  if (!tasks.length) {
    profileTaskHistory.innerHTML = '<p class="empty-state">暂无生成历史。</p>';
    return;
  }

  profileTaskHistory.innerHTML = tasks
    .map(
      (task) => `
        <article class="task-card">
          <img src="${escapeHtml(imageForTask(task))}" alt="生成历史预览" />
          <div>
            <span>${task.workflow === "model-bag-replacement" ? "一键换包" : "商品图生成"} / ${escapeHtml(formatDateTime(task.createdAt))}</span>
            <strong>${escapeHtml(task.id)}</strong>
            <p>${escapeHtml(task.prompt || "无 prompt")}</p>
          </div>
        </article>
      `,
    )
    .join("");
}

async function loadProfileTasks() {
  const response = await fetch("/api/tasks?limit=30", {
    headers: requestHeaders(),
  });
  if (!response.ok) return;
  const data = await response.json();
  renderProfileTasks(data.tasks || []);
}

function showPage(pageId) {
  const nextPageId = document.querySelector(`#${pageId}`) ? pageId : "home";
  pages.forEach((page) => page.classList.toggle("is-active", page.id === nextPageId));
  pageLinks.forEach((link) => {
    const linkPageId = link.getAttribute("href")?.replace("#", "");
    link.classList.toggle("is-active", linkPageId === nextPageId);
  });
}

function syncPageFromHash() {
  showPage(window.location.hash.replace("#", "") || "home");
}

function getSelectedModules() {
  return [...document.querySelectorAll(".checks input:checked")].map((item) => item.value);
}

function getPromptScore(text) {
  const trimmed = text.trim();
  let score = 38;
  if (trimmed.length > 20) score += 14;
  if (trimmed.length > 55) score += 12;
  if (/材质|皮革|五金|纹理|颜色|光线|背景|模特|场景/.test(trimmed)) score += 18;
  if (/不要|避免|突出|强调|干净|高级|自然/.test(trimmed)) score += 12;
  return Math.min(score, 96);
}

function updatePromptScore() {
  const score = getPromptScore(customPromptInput.value);
  promptScore.textContent = score;
  scoreBar.style.width = `${score}%`;
}

function buildPromptPayload() {
  const productType = document.querySelector("#productType").value;
  const usage = document.querySelector("#usage").value;
  const channelPreset = document.querySelector("#channelPreset").value;
  const brandKit = document.querySelector("#brandKit").value;
  const deliveryTier = document.querySelector("#deliveryTier").value;
  const aspectRatio = document.querySelector("#aspectRatio").value;
  const realism = document.querySelector("#realism").value;
  const variantCount = Number(document.querySelector("#variantCount").value);
  const generationMode = document.querySelector("#generationMode").value;
  const customPrompt = document.querySelector("#customPrompt").value.trim();
  const modules = getSelectedModules();
  const score = getPromptScore(customPrompt);

  const prompt = [
    realism,
    usage,
    productType,
    brandKit,
    channelPreset,
    selectedTemplate,
    "AI ecommerce product photography for ecommerce conversion",
    "fashion model presenting the product naturally",
    customPrompt || "clean luxury studio scene, premium leather texture, commercial lighting",
    deliveryTier,
    modules.join(", "),
  ]
    .filter(Boolean)
    .join(", ");

  const variantPrompts = Array.from({ length: variantCount }, (_, index) => {
    const angle = ["front hero shot", "three-quarter detail shot", "lifestyle close-up", "ad-ready composition"][index % 4];
    return `${prompt}, variant ${index + 1}, ${angle}`;
  });

  return {
    workflow: "ecommerce-product-image",
    prompt,
    negativePrompt:
      "low quality, blurry, distorted hands, warped product, fake texture, watermark, extra fingers, unreadable text",
    productType,
    usage,
    channelPreset,
    brandKit,
    deliveryTier,
    aspectRatio,
    realism,
    variantCount,
    generationMode,
    selectedTemplate,
    modules,
    promptScore: score,
    variantPrompts,
    seed: Math.floor(Math.random() * 1000000),
  };
}

function getCommercialGrade(payload) {
  if (payload.promptScore >= 86 && payload.modules.length >= 5) return "A";
  if (payload.promptScore >= 72) return "B+";
  if (payload.promptScore >= 58) return "B";
  return "C";
}

function renderQualityChecklist(payload, response = null) {
  const grade = getCommercialGrade(payload);
  const hasRetouch = payload.deliveryTier.startsWith("manual retouch review");
  const hasChannel = Boolean(payload.channelPreset);
  const checklist = [
    hasChannel ? "已写入渠道规格，生成后按主图/封面/广告裁切复核。" : "建议补充渠道规格，避免构图不可用。",
    payload.modules.includes("keep product shape and material consistent")
      ? "已锁定包型和材质一致性，仍需人工比对实物色差。"
      : "建议开启商品一致性锁定，降低包型漂移。",
    payload.modules.includes("accurate hands and bag straps")
      ? "已强调手部和肩带自然，出图后优先筛掉畸形握持。"
      : "建议加入手部、肩带约束。",
    hasRetouch ? "进阶生成包含重点复核提示，适合高还原度订单。" : "当前等级适合普通预览或正常商用出图，复杂 logo/五金不要过度承诺。",
  ];

  qualityScore.textContent = response?.provider === "postgresql" ? `${grade} / 已入库` : grade;
  qualityChecklist.innerHTML = checklist.map((item) => `<li>${item}</li>`).join("");
}

async function requestImageGeneration(payload) {
  if (!COMFYUI_ENDPOINT) {
    await new Promise((resolve) => setTimeout(resolve, 1100));
    return {
      id: `mock-${Date.now()}`,
      imageUrl: MOCK_IMAGE_URL,
      variants: payload.variantPrompts.map((variantPrompt, index) => ({
        id: `v${index + 1}`,
        imageUrl: MOCK_IMAGE_URL,
        prompt: variantPrompt,
      })),
      provider: "mock",
      payload,
    };
  }

  const response = await fetch(COMFYUI_ENDPOINT, {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.error || `生成接口请求失败：${response.status}`);
  }

  return response.json();
}

function setBusy(isBusy) {
  loadingState.hidden = !isBusy;
  if (isBusy) {
    statusPill.textContent = "生成中";
  }
  form.querySelector(".submit-button").disabled = isBusy;
  if (!isBusy) updateAccessState();
}

function setReplaceBusy(isBusy) {
  replaceLoading.hidden = !isBusy;
  if (isBusy) {
    replaceStatus.textContent = "替换中";
  }
  replaceForm.querySelector(".submit-button").disabled = isBusy;
  if (!isBusy) updateAccessState();
}

function getUploadedCount() {
  return Object.values(replacementAssets).filter(Boolean).length;
}

function updateReplaceReadiness() {
  const uploadedCount = getUploadedCount();
  replaceReadiness.textContent = `已上传 ${uploadedCount}/5 张参考图`;
  replaceStatus.textContent = uploadedCount === 5 ? "可替换" : "待上传";
}

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", reject);
    reader.readAsDataURL(file);
  });
}

function buildReplacePayload() {
  const holdingStyle = document.querySelector("#holdingStyle").value;
  const blendStrength = document.querySelector("#blendStrength").value;
  const replacePrompt = document.querySelector("#replacePrompt").value.trim();

  return {
    workflow: "model-bag-replacement",
    prompt: [
      "replace the bag in the model image with the uploaded handbag",
      holdingStyle,
      blendStrength,
      replacePrompt || "keep the model identity, pose, lighting, shadows and background consistent",
      "use front, left 45 degree, right 45 degree and top bag references to preserve product shape and details",
    ].join(", "),
    negativePrompt:
      "warped handbag, wrong strap geometry, broken hands, floating bag, mismatched lighting, blurry product, changed face, changed body pose",
    inputs: {
      bagViews: {
        front: replacementAssets.bagFront?.name || null,
        left45: replacementAssets.bagLeft45?.name || null,
        right45: replacementAssets.bagRight45?.name || null,
        top: replacementAssets.bagTop?.name || null,
      },
      modelImage: replacementAssets.modelImage?.name || null,
    },
    imageData: {
      bagFront: replacementAssets.bagFront?.dataUrl || null,
      bagLeft45: replacementAssets.bagLeft45?.dataUrl || null,
      bagRight45: replacementAssets.bagRight45?.dataUrl || null,
      bagTop: replacementAssets.bagTop?.dataUrl || null,
      modelImage: replacementAssets.modelImage?.dataUrl || null,
    },
    controls: {
      holdingStyle,
      blendStrength,
      preserveModel: true,
      preserveProductShape: true,
      matchLighting: true,
    },
    seed: Math.floor(Math.random() * 1000000),
  };
}

async function requestBagReplacement(payload) {
  if (!COMFYUI_ENDPOINT) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return {
      id: `replace-mock-${Date.now()}`,
      imageUrl: payload.imageData.modelImage || MOCK_IMAGE_URL,
      provider: "mock",
      payload,
    };
  }

  const response = await fetch(COMFYUI_ENDPOINT, {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.error || `换包接口请求失败：${response.status}`);
  }

  return response.json();
}

async function loadEntitlement() {
  const response = await fetch("/api/entitlement", {
    headers: requestHeaders(),
  });
  if (response.status === 401) {
    renderAuthState();
    updateAccessState();
    return;
  }
  if (!response.ok) return;
  const data = await response.json();
  activeEntitlement = data.entitlement;
  accountState = data.account || accountState;
  updateAccessState();
}

async function loadAccount() {
  const response = await fetch("/api/account", {
    headers: requestHeaders(),
  });
  if (response.status === 401) {
    clearAuthState();
    return;
  }
  if (!response.ok) return;
  accountState = await response.json();
  renderAuthState();
  updateAccessState();
}

async function submitAuth(mode) {
  const username = authUsername.value.trim();
  const password = authPassword.value;
  const response = await fetch(`/api/auth/${mode}`, {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify({ username, password }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `${mode === "register" ? "注册" : "登录"}失败：${response.status}`);
  }
  applyAuthPayload(data);
  authPassword.value = "";
  await loadEntitlement();
  await loadProfileTasks();
}

async function sendEmailCode() {
  const email = authEmail.value.trim();
  const response = await fetch("/api/auth/email-code/send", {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify({ email }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `发送验证码失败：${response.status}`);
  }
  startEmailCodeCountdown();
  authStatus.textContent = data.message || "验证码已发送";
}

async function submitEmailCodeLogin() {
  const email = authEmail.value.trim();
  const code = authEmailCode.value.trim();
  const response = await fetch("/api/auth/email-code/login", {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify({ email, code }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `邮箱验证码登录失败：${response.status}`);
  }
  applyAuthPayload(data);
  authEmailCode.value = "";
  await loadEntitlement();
  await loadProfileTasks();
}

async function logout() {
  await fetch("/api/auth/logout", {
    method: "POST",
    headers: requestHeaders(),
  }).catch(() => {});
  clearAuthState();
}

async function applyReferralCode(inviteCodeValue) {
  const response = await fetch("/api/referrals", {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify({ inviteCode: inviteCodeValue }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `绑定邀请失败：${response.status}`);
  }
  accountState = data;
  updateAccessState();
}

async function createPayment(packId) {
  const response = await fetch("/api/payments", {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify({ packId }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `创建支付订单失败：${response.status}`);
  }
  return data.payment;
}

async function confirmPendingPayment() {
  if (!pendingPayment) return;
  const response = await fetch(`/api/payments/${pendingPayment.id}/confirm`, {
    method: "POST",
    headers: requestHeaders(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `确认支付失败：${response.status}`);
  }

  pendingPayment = null;
  activeEntitlement = data.entitlement;
  accountState = data.account || accountState;
  await loadAccount();
  confirmPayment.hidden = true;
  paymentHint.textContent = "充值成功，积分已到账。";
  updateAccessState();
}

function renderVariants(variants = []) {
  variantStrip.innerHTML = "";
  variants.forEach((variant, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = index === 0 ? "variant-thumb is-active" : "variant-thumb";
    button.innerHTML = `<img src="${variant.imageUrl}" alt="变体 ${index + 1}" /><span>V${index + 1}</span>`;
    button.addEventListener("click", () => {
      document.querySelectorAll(".variant-thumb").forEach((item) => item.classList.remove("is-active"));
      button.classList.add("is-active");
      resultImage.src = variant.imageUrl;
      promptPreview.textContent = variant.prompt;
    });
    variantStrip.appendChild(button);
  });
}

function getHistory() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveHistory(item) {
  const nextHistory = [item, ...getHistory()].slice(0, 6);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(nextHistory));
  renderHistory();
}

function renderHistory() {
  const history = getHistory();
  if (!history.length) {
    historyList.innerHTML = '<p class="empty-state">暂无生成记录。</p>';
    return;
  }

  historyList.innerHTML = history
    .map(
      (item) => `
        <button class="history-item" type="button" data-id="${item.id}">
          <span>${item.usageLabel}</span>
          <strong>${item.variantCount} 张 / ${item.mode}</strong>
        </button>
      `,
    )
    .join("");
}

function updatePayloadView(payload, response) {
  payloadView.textContent = JSON.stringify(
    {
      endpoint: COMFYUI_ENDPOINT || "mock mode: set COMFYUI_ENDPOINT in app.js",
      request: payload,
      response,
    },
    null,
    2,
  );
}

templateButtons.forEach((button) => {
  button.addEventListener("click", () => {
    templateButtons.forEach((item) => item.classList.remove("is-active"));
    button.classList.add("is-active");
    selectedTemplate = button.dataset.template;
    latestPayload = buildPromptPayload();
    renderQualityChecklist(latestPayload);
  });
});

customPromptInput.addEventListener("input", () => {
  updatePromptScore();
  latestPayload = buildPromptPayload();
  renderQualityChecklist(latestPayload);
});

form.addEventListener("change", () => {
  latestPayload = buildPromptPayload();
  renderQualityChecklist(latestPayload);
  updateAccessState();
});

rechargeButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    if (!isAuthenticated()) {
      paymentHint.textContent = "请先在个人主页登录或注册后再充值。";
      window.location.hash = "profile";
      return;
    }
    const packId = button.dataset.packId;
    button.disabled = true;
    paymentHint.textContent = "正在创建充值订单。";

    try {
      pendingPayment = await createPayment(packId);
      confirmPayment.hidden = false;
      confirmPayment.textContent = `确认充值 ${pendingPayment.creditPack.creditGrant} 积分`;
      paymentHint.textContent = `订单 ${pendingPayment.id} 已创建。当前为模拟支付，点击确认后到账 ${pendingPayment.creditPack.creditGrant} 积分。`;
    } catch (error) {
      paymentHint.textContent = error.message;
    } finally {
      button.disabled = false;
      updateAccessState();
    }
  });
});

confirmPayment.addEventListener("click", async () => {
  if (!isAuthenticated()) {
    paymentHint.textContent = "请先登录后再确认支付。";
    return;
  }
  confirmPayment.disabled = true;
  paymentHint.textContent = "正在确认支付。";

  try {
    await confirmPendingPayment();
  } catch (error) {
    paymentHint.textContent = error.message;
  } finally {
    confirmPayment.disabled = false;
  }
});

refreshEntitlement.addEventListener("click", async () => {
  paymentHint.textContent = "正在刷新支付状态。";
  await loadEntitlement();
  await loadAccount();
  await loadProfileTasks();
});

refreshProfile.addEventListener("click", async () => {
  await loadAccount();
  await loadProfileTasks();
});

refreshTaskHistory.addEventListener("click", loadProfileTasks);

authTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    setActiveAuthMethod(tab.dataset.authTab);
  });
});

authPasswordTab.addEventListener("click", () => setActiveAuthMethod("password"));
authEmailTab.addEventListener("click", () => setActiveAuthMethod("email"));

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginButton.disabled = true;
  registerButton.disabled = true;
  authStatus.textContent = "正在登录。";
  try {
    await submitAuth("login");
    authStatus.textContent = `已登录：${accountDisplayName()}`;
  } catch (error) {
    authStatus.textContent = error.message;
  } finally {
    loginButton.disabled = false;
    registerButton.disabled = false;
  }
});

registerButton.addEventListener("click", async () => {
  loginButton.disabled = true;
  registerButton.disabled = true;
  authStatus.textContent = "正在注册。";
  try {
    await submitAuth("register");
    authStatus.textContent = `注册成功：${accountDisplayName()}`;
  } catch (error) {
    authStatus.textContent = error.message;
  } finally {
    loginButton.disabled = false;
    registerButton.disabled = false;
  }
});

sendEmailCodeButton.addEventListener("click", async () => {
  sendEmailCodeButton.disabled = true;
  authStatus.textContent = "正在发送验证码。";
  try {
    await sendEmailCode();
  } catch (error) {
    authStatus.textContent = error.message;
    updateEmailCodeButton();
  }
});

async function handleEmailCodeLoginSubmit(event) {
  event.preventDefault();
  if (emailLoginButton.disabled) return;
  emailLoginButton.disabled = true;
  authStatus.textContent = "正在登录。";
  try {
    await submitEmailCodeLogin();
    authStatus.textContent = `已登录：${accountDisplayName()}`;
  } catch (error) {
    authStatus.textContent = error.message;
  } finally {
    emailLoginButton.disabled = false;
  }
}

emailAuthForm.addEventListener("submit", handleEmailCodeLoginSubmit);
emailLoginButton.addEventListener("click", handleEmailCodeLoginSubmit);

logoutButton.addEventListener("click", logout);

applyReferral.addEventListener("click", async () => {
  if (!isAuthenticated()) {
    paymentHint.textContent = "请先登录后再绑定邀请码。";
    window.location.hash = "profile";
    return;
  }
  const value = referralCode.value.trim();
  if (!value) {
    paymentHint.textContent = "请输入邀请码。";
    return;
  }

  applyReferral.disabled = true;
  paymentHint.textContent = "正在绑定邀请关系。";
  try {
    await applyReferralCode(value);
    paymentHint.textContent = `绑定完成。邀请奖励会发给邀请码所属账户，奖励 ${accountState.credits.inviteReward} 积分。`;
  } catch (error) {
    paymentHint.textContent = error.message;
  } finally {
    applyReferral.disabled = false;
  }
});

window.addEventListener("hashchange", syncPageFromHash);

exportPayload.addEventListener("click", () => {
  if (!hasPlan(requiredPlanForGeneration())) {
    paymentHint.textContent = `当前生成配置需要 ${CREDIT_COSTS[requiredPlanForGeneration()]} 积分，余额不足请先充值。`;
    return;
  }
  latestPayload = latestPayload || buildPromptPayload();
  const blob = new Blob([JSON.stringify(latestPayload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `imgbest-task-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(url);
});

exportReplacePayload.addEventListener("click", () => {
  if (!hasPlan(requiredPlanForReplacement())) {
    paymentHint.textContent = `一键换包需要 ${CREDIT_COSTS[requiredPlanForReplacement()]} 积分，余额不足请先充值。`;
    return;
  }
  latestReplacePayload = latestReplacePayload || buildReplacePayload();
  const blob = new Blob([JSON.stringify(latestReplacePayload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `imgbest-replace-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(url);
});

clearHistory.addEventListener("click", () => {
  localStorage.removeItem(STORAGE_KEY);
  renderHistory();
});

uploadInputs.forEach((input) => {
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    const key = input.dataset.upload;
    const preview = document.querySelector(`[data-preview="${key}"]`);

    if (!file) return;

    const dataUrl = await readImageFile(file);
    replacementAssets[key] = {
      name: file.name,
      size: file.size,
      type: file.type,
      dataUrl,
    };

    preview.src = dataUrl;
    preview.hidden = false;
    input.closest(".upload-card").classList.add("has-image");
    updateReplaceReadiness();
  });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const payload = buildPromptPayload();
  const requiredPlan = requiredPlanForGeneration();
  if (!isAuthenticated()) {
    statusPill.textContent = "未登录";
    paymentHint.textContent = "请先在个人主页登录或注册账号。";
    window.location.hash = "profile";
    updateAccessState();
    return;
  }
  if (!hasPlan(requiredPlan)) {
    statusPill.textContent = "积分不足";
    paymentHint.textContent = `当前生成配置需要 ${CREDIT_COSTS[requiredPlan]} 积分，余额不足请先充值。`;
    document.querySelector("#packages").scrollIntoView({ behavior: "smooth", block: "start" });
    updateAccessState();
    return;
  }
  if (!hasCredits(requiredPlan)) {
    statusPill.textContent = "积分不足";
    paymentHint.textContent = `本次需要 ${CREDIT_COSTS[requiredPlan]} 积分，当前余额 ${creditBalanceValue()}。`;
    document.querySelector("#packages").scrollIntoView({ behavior: "smooth", block: "start" });
    updateAccessState();
    return;
  }

  latestPayload = payload;
  promptPreview.textContent = payload.prompt;
  payloadView.textContent = JSON.stringify({ request: payload }, null, 2);
  setBusy(true);

  try {
    const response = await requestImageGeneration(payload);
    if (response.credits) {
      accountState = { ...(accountState || {}), credits: response.credits };
    }
    resultImage.src = response.imageUrl || MOCK_IMAGE_URL;
    taskId.textContent = response.id || "-";
    statusPill.textContent = response.provider === "mock" ? "模拟结果" : "生成完成";
    renderVariants(response.variants || [{ imageUrl: response.imageUrl || MOCK_IMAGE_URL, prompt: payload.prompt }]);
    renderQualityChecklist(payload, response);
    saveHistory({
      id: response.id,
      usageLabel: document.querySelector("#usage").selectedOptions[0].textContent,
      variantCount: payload.variantCount,
      mode: document.querySelector("#generationMode").selectedOptions[0].textContent,
    });
    updatePayloadView(payload, response);
    await loadProfileTasks();
  } catch (error) {
    statusPill.textContent = "失败";
    payloadView.textContent = JSON.stringify(
      {
        request: payload,
        error: error.message,
      },
      null,
      2,
    );
  } finally {
    setBusy(false);
  }
});

replaceForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const payload = buildReplacePayload();
  if (!isAuthenticated()) {
    replaceStatus.textContent = "未登录";
    paymentHint.textContent = "请先在个人主页登录或注册账号。";
    window.location.hash = "profile";
    updateAccessState();
    return;
  }
  if (!hasPlan(requiredPlanForReplacement())) {
    replaceStatus.textContent = "积分不足";
    paymentHint.textContent = `一键换包需要 ${CREDIT_COSTS[requiredPlanForReplacement()]} 积分，余额不足请先充值。`;
    document.querySelector("#packages").scrollIntoView({ behavior: "smooth", block: "start" });
    updateAccessState();
    return;
  }
  if (!hasCredits(requiredPlanForReplacement())) {
    replaceStatus.textContent = "积分不足";
    paymentHint.textContent = `一键换包需要 ${CREDIT_COSTS.pro} 积分，当前余额 ${creditBalanceValue()}。`;
    document.querySelector("#packages").scrollIntoView({ behavior: "smooth", block: "start" });
    updateAccessState();
    return;
  }

  latestReplacePayload = payload;
  payloadView.textContent = JSON.stringify({ request: payload }, null, 2);

  if (!replacementAssets.modelImage) {
    replaceStatus.textContent = "缺模特图";
    return;
  }

  if (getUploadedCount() < 5) {
    replaceStatus.textContent = "缺参考图";
    return;
  }

  setReplaceBusy(true);

  try {
    const response = await requestBagReplacement(payload);
    if (response.credits) {
      accountState = { ...(accountState || {}), credits: response.credits };
    }
    replaceResult.src = response.imageUrl || MOCK_IMAGE_URL;
    taskId.textContent = response.id || "-";
    replaceStatus.textContent = response.provider === "mock" ? "模拟结果" : "替换完成";
    updatePayloadView(payload, response);
    await loadProfileTasks();
  } catch (error) {
    replaceStatus.textContent = "失败";
    payloadView.textContent = JSON.stringify(
      {
        request: payload,
        error: error.message,
      },
      null,
      2,
    );
  } finally {
    setReplaceBusy(false);
  }
});

updatePromptScore();
renderQualityChecklist(buildPromptPayload());
renderHistory();
updateReplaceReadiness();
renderAuthState();
updateAccessState();
syncPageFromHash();
if (isAuthenticated()) {
  loadEntitlement();
  loadAccount().then(async () => {
    const invitedBy = new URLSearchParams(window.location.search).get("ref");
    if (invitedBy && !accountState?.account?.referredBy) {
      referralCode.value = invitedBy;
      await applyReferralCode(invitedBy);
      paymentHint.textContent = `已绑定邀请关系，邀请人获得 ${accountState.credits.inviteReward} 积分。`;
    }
    await loadProfileTasks();
  });
} else {
  const invitedBy = new URLSearchParams(window.location.search).get("ref");
  if (invitedBy) referralCode.value = invitedBy;
}
