const CHAR_LIMIT = 300; // equivalent to roughly 50 words

const el = (id) => document.getElementById(id);

const state = {
  provider: localStorage.getItem("ff_provider") || "gemini",
  apiKey: localStorage.getItem("ff_apiKey") || "",
  model: localStorage.getItem("ff_model") || "",
  currentTopic: null,
  currentQuestion: null,
  fallacies: [],
};

function showError(message) {
  const banner = el("errorBanner");
  banner.textContent = message;
  banner.classList.remove("hidden");
}

function clearError() {
  el("errorBanner").classList.add("hidden");
}

function setLoading(isLoading, text) {
  el("loadingIndicator").classList.toggle("hidden", !isLoading);
  if (text) el("loadingText").textContent = text;
}

async function apiCall(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed.");
  return data;
}

async function loadFallacyReference() {
  try {
    const res = await fetch("/api/fallacies");
    state.fallacies = await res.json();
    renderReference(state.fallacies);
  } catch {
    /* reference panel is a nice-to-have; ignore failures */
  }
}

function renderReference(list) {
  const container = el("referenceList");
  container.innerHTML = "";
  for (const f of list) {
    const item = document.createElement("div");
    item.className = "reference-item";
    item.innerHTML = `
      <span class="fallacy-name">${f.name}</span><span class="fallacy-category">${f.category}</span>
      <p>${f.description}</p>
    `;
    container.appendChild(item);
  }
}

function requireApiKey() {
  if (!state.apiKey || !state.model) {
    showError("Add your API key and model in Settings first.");
    el("settingsModal").classList.remove("hidden");
    return false;
  }
  return true;
}

async function startNewRound() {
  if (!requireApiKey()) return;
  clearError();
  el("resultsCard").classList.add("hidden");
  el("responseCard").classList.add("hidden");
  el("roundPoints").textContent = "–";
  setLoading(true, "Dreaming up a topic…");
  try {
    const data = await apiCall("/api/round", {
      provider: state.provider,
      apiKey: state.apiKey,
      model: state.model,
    });
    state.currentTopic = data.topic;
    state.currentQuestion = data.question;
    el("topicLabel").textContent = data.topic;
    el("questionText").textContent = data.question;
    el("scenarioEmpty").classList.add("hidden");
    el("scenarioContent").classList.remove("hidden");
    el("responseCard").classList.remove("hidden");
    el("responseInput").value = "";
    updateWordCount();
    el("responseInput").focus();
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
}

function updateWordCount() {
  const count = el("responseInput").value.trim().length;
  const label = el("wordCount");
  label.textContent = `${count} / ${CHAR_LIMIT} characters`;
  label.classList.toggle("over", count > CHAR_LIMIT);
  el("submitBtn").disabled = count === 0 || count > CHAR_LIMIT;
}

async function submitResponse() {
  if (!requireApiKey()) return;
  clearError();
  const response = el("responseInput").value.trim();
  if (!response) return;

  setLoading(true, "Scanning for fallacies…");
  el("resultsCard").classList.add("hidden");
  try {
    const data = await apiCall("/api/analyze", {
      provider: state.provider,
      apiKey: state.apiKey,
      model: state.model,
      topic: state.currentTopic,
      question: state.currentQuestion,
      response,
    });
    renderResults(data);
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
}

function renderResults(data) {
  el("commentary").textContent = data.commentary || "";
  el("fallacyCount").textContent = data.fallacies.length;
  el("roundScore").textContent = data.score;
  el("roundPoints").textContent = data.score;

  const list = el("fallacyList");
  list.innerHTML = "";
  if (data.onTopic === false) {
    const li = document.createElement("li");
    li.className = "no-fallacies";
    li.textContent = "That didn't engage with the question at all, so nothing counts. Try an argument that actually addresses it (however fallaciously).";
    list.appendChild(li);
  } else if (data.fallacies.length === 0) {
    const li = document.createElement("li");
    li.className = "no-fallacies";
    li.textContent = "No fallacies detected. Try harder next time!";
    list.appendChild(li);
  } else {
    for (const f of data.fallacies) {
      const li = document.createElement("li");
      li.innerHTML = `
        <span class="fallacy-name">${f.name}</span>
        <span class="fallacy-quote">"${f.quote}"</span>
        <span class="fallacy-explanation">${f.explanation}</span>
      `;
      list.appendChild(li);
    }
  }
  el("resultsCard").classList.remove("hidden");
}

// Settings modal
function resetModelSelect(message) {
  const select = el("modelSelect");
  select.innerHTML = "";
  select.disabled = true;
  const opt = document.createElement("option");
  opt.value = "";
  opt.textContent = message;
  select.appendChild(opt);
}

function openSettings() {
  el("providerSelect").value = state.provider;
  el("apiKeyInput").value = state.apiKey;
  el("modelStatus").textContent = "";
  if (state.apiKey) {
    detectModels();
  } else {
    resetModelSelect("Enter your API key above…");
  }
  el("settingsModal").classList.remove("hidden");
}

function closeSettings() {
  el("settingsModal").classList.add("hidden");
}

async function detectModels() {
  const provider = el("providerSelect").value;
  const apiKey = el("apiKeyInput").value.trim();
  if (!apiKey) {
    resetModelSelect("Enter your API key above…");
    return;
  }
  resetModelSelect("Checking with the provider…");
  el("modelStatus").textContent = "Checking with the provider…";
  try {
    const data = await apiCall("/api/models", { provider, apiKey });
    const select = el("modelSelect");
    select.innerHTML = "";
    if (data.models.length === 0) {
      resetModelSelect("No usable models found");
      el("modelStatus").textContent = "No usable models were found for this key.";
      return;
    }
    for (const m of data.models) {
      const opt = document.createElement("option");
      opt.value = m.name;
      opt.textContent = m.displayName === m.name ? m.name : `${m.displayName} (${m.name})`;
      select.appendChild(opt);
    }
    select.disabled = false;
    const preferred =
      data.models.find((m) => m.name === state.model) ||
      data.models.find((m) => /lite|mini|haiku/i.test(m.name)) ||
      data.models.find((m) => /flash|mini|haiku/i.test(m.name)) ||
      data.models[0];
    select.value = preferred.name;
    el("modelStatus").textContent = `Found ${data.models.length} available model(s).`;
  } catch (err) {
    resetModelSelect("Couldn't load models");
    el("modelStatus").textContent = err.message;
  }
}

function saveSettings() {
  state.provider = el("providerSelect").value;
  state.apiKey = el("apiKeyInput").value.trim();
  state.model = el("modelSelect").value;
  localStorage.setItem("ff_provider", state.provider);
  localStorage.setItem("ff_apiKey", state.apiKey);
  localStorage.setItem("ff_model", state.model);
  closeSettings();
  clearError();
}

// Reference drawer
function openReference() {
  el("referenceDrawer").classList.remove("hidden");
  el("drawerOverlay").classList.remove("hidden");
}

function closeReference() {
  el("referenceDrawer").classList.add("hidden");
  el("drawerOverlay").classList.add("hidden");
}

// Help modal
function openHelp() {
  el("helpModal").classList.remove("hidden");
}

function closeHelp() {
  el("helpModal").classList.add("hidden");
}

el("newRoundBtn").addEventListener("click", startNewRound);
el("newRoundBtn2").addEventListener("click", startNewRound);
el("playAgainBtn").addEventListener("click", startNewRound);
el("submitBtn").addEventListener("click", submitResponse);
el("responseInput").addEventListener("input", updateWordCount);

el("settingsBtn").addEventListener("click", openSettings);
el("closeSettingsBtn").addEventListener("click", closeSettings);
el("saveSettingsBtn").addEventListener("click", saveSettings);
el("providerSelect").addEventListener("change", detectModels);
el("apiKeyInput").addEventListener("change", detectModels);
let apiKeyDebounce;
el("apiKeyInput").addEventListener("input", () => {
  clearTimeout(apiKeyDebounce);
  apiKeyDebounce = setTimeout(detectModels, 600);
});

el("referenceBtn").addEventListener("click", openReference);
el("closeReferenceBtn").addEventListener("click", closeReference);
el("drawerOverlay").addEventListener("click", closeReference);

el("helpBtn").addEventListener("click", openHelp);
el("closeHelpBtn").addEventListener("click", closeHelp);

el("referenceSearch").addEventListener("input", (e) => {
  const q = e.target.value.toLowerCase();
  const filtered = state.fallacies.filter(
    (f) =>
      f.name.toLowerCase().includes(q) ||
      f.description.toLowerCase().includes(q)
  );
  renderReference(filtered);
});

loadFallacyReference();
if (!state.apiKey) {
  openSettings();
}
