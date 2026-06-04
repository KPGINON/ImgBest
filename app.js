const COMFYUI_ENDPOINT = "/api/generate-image";
const MOCK_IMAGE_URL = "./assets/hero-bag-model.png";
const STORAGE_KEY = "imgbest-generation-history";

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

let selectedTemplate = document.querySelector(".template-card.is-active")?.dataset.template || "";
let latestPayload = null;
let latestReplacePayload = null;
const replacementAssets = {
  bagFront: null,
  bagLeft45: null,
  bagRight45: null,
  bagTop: null,
  modelImage: null,
};

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
  const hasRetouch = payload.deliveryTier.includes("manual retouch");
  const hasChannel = Boolean(payload.channelPreset);
  const checklist = [
    hasChannel ? "已写入渠道规格，生成后按主图/封面/广告裁切复核。" : "建议补充渠道规格，避免构图不可用。",
    payload.modules.includes("keep product shape and material consistent")
      ? "已锁定包型和材质一致性，仍需人工比对实物色差。"
      : "建议开启商品一致性锁定，降低包型漂移。",
    payload.modules.includes("accurate hands and bag straps")
      ? "已强调手部和肩带自然，出图后优先筛掉畸形握持。"
      : "建议加入手部、肩带约束。",
    hasRetouch ? "交付等级包含人工精修复核，适合高还原度订单。" : "当前等级适合预览或商用精选，复杂 logo/五金不要过度承诺。",
  ];

  qualityScore.textContent = response?.provider === "node-sqlite" ? `${grade} / 已入库` : grade;
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
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`生成接口请求失败：${response.status}`);
  }

  return response.json();
}

function setBusy(isBusy) {
  loadingState.hidden = !isBusy;
  if (isBusy) {
    statusPill.textContent = "生成中";
  }
  form.querySelector(".submit-button").disabled = isBusy;
}

function setReplaceBusy(isBusy) {
  replaceLoading.hidden = !isBusy;
  if (isBusy) {
    replaceStatus.textContent = "替换中";
  }
  replaceForm.querySelector(".submit-button").disabled = isBusy;
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
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`换包接口请求失败：${response.status}`);
  }

  return response.json();
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
});

exportPayload.addEventListener("click", () => {
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
  latestPayload = payload;
  promptPreview.textContent = payload.prompt;
  payloadView.textContent = JSON.stringify({ request: payload }, null, 2);
  setBusy(true);

  try {
    const response = await requestImageGeneration(payload);
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
    replaceResult.src = response.imageUrl || MOCK_IMAGE_URL;
    taskId.textContent = response.id || "-";
    replaceStatus.textContent = response.provider === "mock" ? "模拟结果" : "替换完成";
    updatePayloadView(payload, response);
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
