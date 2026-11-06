const state = {
  config: null,
  selectedPresetId: null,
  editorTab: "main",
  activeView: "studio",
  dirty: false,
  dashboard: null,
  mediaLibrary: null,
  adspowerProxies: [],
  mailboxes: [],
  mediaVaultId: null,
  mediaDayId: null,
  mediaCategory: "primary",
  mediaUploadContext: "either",
  mediaEditorItemId: null,
  activeCycleIndex: 0,
  expandedCtaKey: "",
  expandedPhaseKey: "",
  expandedObjectionKey: "",
  expandedUrlKey: "",
  expandedSprinkleKey: "",
  expandedFollowupKey: "",
  expandedFinisherKey: "",
  collapsedOpenerKeys: new Set(),
  collapsedFinisherKeys: new Set(),
  selectedAccountId: null,
  selectedConversationId: null,
  conversations: [],
  search: "",
  engineKeyDraft: "",
  engineProfiles: null,
  ollamaKeyDraft: null,
  visionKeyDraft: "",
  playgroundMessages: [],
  playgroundMediaVaultId: "",
  playgroundDebugTab: "request",
  playgroundLastRequest: null,
  playgroundLastResponse: null,
  playgroundRunId: 0,
  playgroundStopped: false,
  playgroundStopReason: "",
  snapFleet: null,
  snapFleetReports: [],
  snapFleetLoading: false,
};

const elements = {
  app: document.querySelector("#app"),
  loginView: document.querySelector("#login-view"),
  loginForm: document.querySelector("#login-form"),
  loginError: document.querySelector("#login-error"),
  adminKey: document.querySelector("#admin-key"),
  logoutButton: document.querySelector("#logout-button"),
  sidebarLogoutButton: document.querySelector("#sidebar-logout-button"),
  pageEyebrow: document.querySelector("#page-eyebrow"),
  pageTitle: document.querySelector("#page-title"),
  saveButton: document.querySelector("#save-button"),
  saveStatus: document.querySelector("#save-status"),
  presetList: document.querySelector("#preset-list"),
  presetHeading: document.querySelector("#preset-heading"),
  presetCtaToggle: document.querySelector("#preset-cta-toggle"),
  editorContent: document.querySelector("#editor-content"),
  editorTabs: document.querySelector("#editor-tabs"),
  addPreset: document.querySelector("#add-preset"),
  duplicatePreset: document.querySelector("#duplicate-preset"),
  deletePreset: document.querySelector("#delete-preset"),
  exportPreset: document.querySelector("#export-preset"),
  importPreset: document.querySelector("#import-preset"),
  presetImportInput: document.querySelector("#preset-import-input"),
  mediaPresetSelect: document.querySelector("#media-preset-select"),
  mediaVaultIdCard: document.querySelector("#media-vault-id-card"),
  mediaAddVaultButton: document.querySelector("#media-add-vault-button"),
  mediaRenameVault: document.querySelector("#media-rename-vault"),
  mediaDeleteVault: document.querySelector("#media-delete-vault"),
  mediaUploadInput: document.querySelector("#media-upload-input"),
  mediaAddDay: document.querySelector("#media-add-day"),
  mediaDayList: document.querySelector("#media-day-list"),
  mediaDayHeading: document.querySelector("#media-day-heading"),
  mediaCategoryTabs: document.querySelector("#media-category-tabs"),
  mediaGrid: document.querySelector("#media-grid"),
  mediaCount: document.querySelector("#media-count"),
  accountConfigList: document.querySelector("#account-config-list"),
  engineSettings: document.querySelector("#engine-settings"),
  playgroundPreset: document.querySelector("#playground-preset"),
  playgroundModel: document.querySelector("#playground-model"),
  playgroundEngineStatus: document.querySelector("#playground-engine-status"),
  playgroundMessages: document.querySelector("#playground-messages"),
  playgroundForm: document.querySelector("#playground-form"),
  playgroundInput: document.querySelector("#playground-input"),
  playgroundImageInput: document.querySelector("#playground-image-input"),
  resetPlayground: document.querySelector("#reset-playground"),
  playgroundRequest: document.querySelector("#playground-request"),
  playgroundResponse: document.querySelector("#playground-response"),
  refreshButton: document.querySelector("#refresh-button"),
  metricOnline: document.querySelector("#metric-online"),
  metricConversations: document.querySelector("#metric-conversations"),
  metricUnread: document.querySelector("#metric-unread"),
  metricPending: document.querySelector("#metric-pending"),
  accountList: document.querySelector("#account-list"),
  chatnowAddAccount: document.querySelector("#chatnow-add-account"),
  chatnowAccountConfigList: document.querySelector("#chatnow-account-config-list"),
  conversationTitle: document.querySelector("#conversation-title"),
  conversationCount: document.querySelector("#conversation-count"),
  conversationSearch: document.querySelector("#conversation-search"),
  conversationList: document.querySelector("#conversation-list"),
  messageEmpty: document.querySelector("#message-empty"),
  messageView: document.querySelector("#message-view"),
  partnerName: document.querySelector("#partner-name"),
  partnerMeta: document.querySelector("#partner-meta"),
  messages: document.querySelector("#messages"),
  aiProcessButton: document.querySelector("#ai-process-button"),
  replyForm: document.querySelector("#reply-form"),
  replyInput: document.querySelector("#reply-input"),
  toast: document.querySelector("#toast"),
};

const languageOptions = [
  { value: "French", label: "French" },
  { value: "English", label: "English" },
  { value: "Spanish", label: "Spanish" },
  { value: "Italian", label: "Italian" },
  { value: "German", label: "German" },
  { value: "Auto", label: "Auto / derniere langue utilisateur" },
];

const identityLanguageOptions = [
  { value: "fr", label: "Francais" },
  { value: "en", label: "Anglais" },
  { value: "auto", label: "Detection automatique" },
];

const recreateTriggerOptions = [
  { value: "chatnow_ban", label: "Ban ChatNow" },
  { value: "chatnow_mute", label: "Mute ChatNow" },
  { value: "worker_error", label: "Session / worker en erreur" },
];

function normalizeRecreateTrigger(value) {
  return recreateTriggerOptions.some((option) => option.value === value)
    ? value
    : "chatnow_ban";
}

function recreateTriggerOptionMarkup(selectedValue) {
  const selected = normalizeRecreateTrigger(selectedValue);
  return recreateTriggerOptions.map((option) => `
    <option value="${escapeHtml(option.value)}" ${option.value === selected ? "selected" : ""}>
      ${escapeHtml(option.label)}
    </option>
  `).join("");
}

function recreateTriggerLabel(value) {
  const selected = normalizeRecreateTrigger(value);
  return recreateTriggerOptions.find((option) => option.value === selected)?.label || "Ban ChatNow";
}

async function api(pathname, options = {}) {
  const response = await fetch(pathname, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: "same-origin",
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && pathname !== "/api/login") showLogin();
  if (!response.ok) throw new Error(payload.error || `Erreur ${response.status}`);
  return payload;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showLogin() {
  // session perdue ou fermée : ni la clé en clair d'une création récente ni la liste ne restent en mémoire
  state.assistantUi = null;
  elements.app.hidden = true;
  elements.loginView.hidden = false;
  setTimeout(() => elements.adminKey.focus(), 0);
}

function showApp() {
  elements.loginView.hidden = true;
  elements.app.hidden = false;
}

let toastTimeout;
function showToast(message, type = "success") {
  clearTimeout(toastTimeout);
  elements.toast.textContent = message;
  elements.toast.className = `toast visible ${type === "error" ? "error" : ""}`;
  toastTimeout = setTimeout(() => {
    elements.toast.className = "toast";
  }, 4_000);
}

function markDirty() {
  state.dirty = true;
  elements.saveStatus.textContent = "Modifications non enregistrées";
  elements.saveStatus.className = "save-status dirty";
}

function markSaved() {
  state.dirty = false;
  elements.saveStatus.textContent = "Synchronisé";
  elements.saveStatus.className = "save-status";
}

function activePresets() {
  return configPresets().filter(preset => !preset.archivedAt);
}

// --- Groupes de presets -----------------------------------------------------
// Un groupe n'est qu'une etiquette texte sur le preset (preset.group). Rien cote serveur: le
// champ est conserve tel quel a l'enregistrement, comme preset.archivedAt.
const presetGroupCollator = new Intl.Collator("fr", { sensitivity: "base", numeric: true });
const PRESET_GROUP_MAX = 40;

function presetGroupOf(preset) {
  return String(preset?.group || "").trim().slice(0, PRESET_GROUP_MAX);
}

function presetGroupNames(presets = activePresets()) {
  return [...new Set(presets.map(presetGroupOf).filter(Boolean))].sort(presetGroupCollator.compare);
}

// [{ name, presets }] : groupes tries, "Sans groupe" ("") en dernier, presets tries par nom.
// Tant qu'aucun preset n'a de groupe, on rend la liste a plat dans l'ordre d'origine.
function groupedPresetEntries(presets) {
  if (!presets.some((preset) => presetGroupOf(preset))) return [{ name: "", presets, flat: true }];
  const parNom = new Map();
  for (const preset of presets) {
    const name = presetGroupOf(preset);
    if (!parNom.has(name)) parNom.set(name, []);
    parNom.get(name).push(preset);
  }
  const noms = [...parNom.keys()].sort((a, b) => (a === "") - (b === "") || presetGroupCollator.compare(a, b));
  return noms.map((name) => ({
    name,
    presets: parNom.get(name).slice().sort((a, b) => presetGroupCollator.compare(a.name || "", b.name || "")),
  }));
}

function presetOptionsHtml(presets, selectedId, labelOf = (preset) => `${preset.name} (${preset.id})`, flat = false) {
  const option = (preset) => `
    <option value="${escapeHtml(preset.id)}" ${preset.id === selectedId ? "selected" : ""}>${escapeHtml(labelOf(preset))}</option>`;
  if (flat) return presets.slice().sort((a, b) => presetGroupCollator.compare(a.name || "", b.name || "")).map(option).join("");
  return groupedPresetEntries(presets).map((entry) => {
    if (entry.flat) return entry.presets.map(option).join("");
    const title = `${entry.name || "Sans groupe"} (${entry.presets.length})`;
    return `<optgroup label="${escapeHtml(title)}">${entry.presets.map(option).join("")}</optgroup>`;
  }).join("");
}

function setPresetGroup(presetId, group) {
  const preset = configPresets().find((item) => item.id === presetId);
  if (!preset) return;
  const value = String(group || "").trim().slice(0, PRESET_GROUP_MAX);
  if (value) preset.group = value; else delete preset.group;
  markDirty();
}

// Filtre de la liste: "all" (tous les presets), "none" (sans groupe) ou "g:<nom du groupe>".
let presetGroupFilter = "all";
try { presetGroupFilter = window.localStorage.getItem("bambou.presetGroupFilter") || "all"; } catch (_) { /* stockage indisponible */ }

function setPresetGroupFilter(value) {
  presetGroupFilter = value || "all";
  try { window.localStorage.setItem("bambou.presetGroupFilter", presetGroupFilter); } catch (_) { /* stockage indisponible */ }
}

function presetFilterOf(preset) {
  const name = presetGroupOf(preset);
  return name ? `g:${name}` : "none";
}

// Presets visibles sous le filtre courant. Un filtre devenu vide revient sur "all", et le preset
// ouvert reste toujours visible: si une edition le sort du filtre, le filtre le suit.
function visiblePresets() {
  const presets = activePresets();
  const filters = new Set(presets.map(presetFilterOf));
  if (presetGroupFilter !== "all" && (!filters.has(presetGroupFilter) || (presetGroupFilter === "none" && filters.size < 2))) setPresetGroupFilter("all");
  const selected = presets.find((preset) => preset.id === state.selectedPresetId);
  if (selected && presetGroupFilter !== "all" && presetFilterOf(selected) !== presetGroupFilter) setPresetGroupFilter(presetFilterOf(selected));
  return presetGroupFilter === "all" ? presets : presets.filter((preset) => presetFilterOf(preset) === presetGroupFilter);
}

function presetGroupChipsHtml() {
  const presets = activePresets();
  const names = presetGroupNames(presets);
  const sans = presets.filter((preset) => !presetGroupOf(preset)).length;
  const chip = (value, label, count) => `
    <button type="button" class="group-chip ${value === presetGroupFilter ? "active" : ""}" data-group-filter="${escapeHtml(value)}" aria-pressed="${value === presetGroupFilter}" title="${escapeHtml(label)}"><span class="gc-label">${escapeHtml(label)}</span><span class="gc-count">${count}</span></button>`;
  return [
    chip("all", "All", presets.length),
    ...names.map((name) => chip(`g:${name}`, name, presets.filter((preset) => presetGroupOf(preset) === name).length)),
    ...(names.length && sans ? [chip("none", "No group", sans)] : []),
  ].join("");
}

// Liste deroulante d'affectation (fiche preset et organisateur). Valeurs: "" = sans groupe,
// "g:<nom>" = un groupe, "new" = en creer un.
function presetGroupChoicesHtml(current) {
  const names = presetGroupNames();
  if (current && !names.includes(current)) names.push(current);
  return [
    `<option value="" ${current === "" ? "selected" : ""}>(No group)</option>`,
    ...names.map((name) => `<option value="g:${escapeHtml(name)}" ${name === current ? "selected" : ""}>${escapeHtml(name)}</option>`),
    '<option value="new">＋ New group…</option>',
  ].join("");
}

// Nom de groupe choisi dans une de ces listes; null si l'utilisateur annule la creation.
function chosenPresetGroup(select) {
  if (select.value === "new") {
    const name = String(window.prompt("New group name:", "") || "").trim().slice(0, PRESET_GROUP_MAX);
    return name || null;
  }
  return select.value.startsWith("g:") ? select.value.slice(2) : "";
}

function refreshPresetGroupUi() {
  renderPresetList();
  renderPresetOrganizer();
  const select = document.querySelector("[data-preset-group-select]");
  if (select) select.innerHTML = presetGroupChoicesHtml(presetGroupOf(currentPreset()));
}

document.addEventListener("change", (event) => {
  const select = event.target?.closest?.("[data-preset-group-select]");
  if (!select) return;
  const preset = currentPreset();
  const group = chosenPresetGroup(select);
  if (preset && group !== null) setPresetGroup(preset.id, group);
  refreshPresetGroupUi();
});

function renderPresetOrganizer() {
  const body = document.getElementById("preset-organizer-body");
  if (!body) return;
  const presets = activePresets();
  const entries = groupedPresetEntries(presets).map((entry) => entry.flat ? { name: "", presets: entry.presets } : entry);
  body.innerHTML = `
    <p class="field-help">Choisis un groupe pour chaque preset. N'oublie pas d'enregistrer.</p>
    ${entries.map((entry) => `
      <div class="organizer-group">
        <div class="organizer-group-head">
          <strong>${escapeHtml(entry.name || "Sans groupe")}</strong>
          <span class="organizer-count">${entry.presets.length}</span>
          ${entry.name ? `
            <button type="button" class="organizer-btn" data-group-rename="${escapeHtml(entry.name)}">Renommer</button>
            <button type="button" class="organizer-btn danger" data-group-dissolve="${escapeHtml(entry.name)}">Dissoudre</button>` : ""}
        </div>
        ${entry.presets.map((preset) => `
          <label class="organizer-row">
            <span>${escapeHtml(preset.name)} <small class="organizer-id">(${escapeHtml(preset.id)})</small></span>
            <select data-organizer-preset="${escapeHtml(preset.id)}">${presetGroupChoicesHtml(presetGroupOf(preset))}</select>
          </label>`).join("")}
      </div>`).join("")}
  `;
  for (const select of body.querySelectorAll("[data-organizer-preset]")) {
    select.addEventListener("change", () => {
      const group = chosenPresetGroup(select);
      if (group !== null) setPresetGroup(select.dataset.organizerPreset, group);
      refreshPresetGroupUi();
    });
  }
  for (const button of body.querySelectorAll("[data-group-rename]")) {
    button.addEventListener("click", () => {
      const ancien = button.dataset.groupRename;
      const nouveau = String(window.prompt(`Nouveau nom du groupe « ${ancien} » :`, ancien) || "").trim();
      if (!nouveau || nouveau === ancien) return;
      for (const preset of presets) if (presetGroupOf(preset) === ancien) setPresetGroup(preset.id, nouveau);
      if (presetGroupFilter === `g:${ancien}`) setPresetGroupFilter(`g:${nouveau.slice(0, PRESET_GROUP_MAX)}`);
      refreshPresetGroupUi();
    });
  }
  for (const button of body.querySelectorAll("[data-group-dissolve]")) {
    button.addEventListener("click", () => {
      const nom = button.dataset.groupDissolve;
      if (!window.confirm(`Dissoudre le groupe « ${nom} » ? Ses presets passent en « Sans groupe ».`)) return;
      for (const preset of presets) if (presetGroupOf(preset) === nom) setPresetGroup(preset.id, "");
      refreshPresetGroupUi();
    });
  }
}

function currentPreset() {
  const presets = activePresets();
  return presets.find(
    (preset) => preset.id === state.selectedPresetId,
  ) || presets[0];
}

function configPresets() {
  return Array.isArray(state.config?.presets) ? state.config.presets : [];
}

function hasStudioConfig(value) {
  return Boolean(value) && Array.isArray(value.presets) && Array.isArray(value.accounts);
}

async function applyPayloadConfig(payload) {
  if (hasStudioConfig(payload?.config)) {
    state.config = payload.config;
    return;
  }
  state.config = await api("/api/studio/config");
}

const studioTabTitles = {
  optimizations: ["AI Chatting", "Optimizations"],
  main: ["AI Chatting", "Main Settings"],
  openers: ["AI Chatting", "Openers"],
  phases: ["AI Chatting", "Chatting Phases"],
  cta: ["AI Chatting", "Call-To-Action"],
  urls: ["AI Chatting", "URLs"],
  objections: ["AI Chatting", "Objections"],
  sprinkles: ["AI Chatting", "Sprinkles"],
  followups: ["AI Chatting", "Follow-ups"],
  finishers: ["AI Chatting", "Finisher"],
  ignorelist: ["AI Chatting", "Ignore condition"],
  media: ["Workspace", "Media Vault"],
};

function updatePageHeader() {
  const titles = {
    studio: studioTabTitles[state.editorTab] || ["Settings", "Settings"],
    archives: ["Presets", "Archives"],
    media: ["Workspace", "Media Vault"],
    accounts: ["Settings", "Settings & Accounts"],
    playground: ["Evaluation", "Playground"],
    monitor: ["Live", "ChatNow"],
    conversations: ["Live", "Conversations"],
    omegleweb: ["Extension", "Réglages extension"],
    blocked: ["Extension", "Messages bloqués"],
    snapchat: ["Snapchat", "Settings Snapchat"],
    apikeys: ["Settings", "API Keys"],
  };
  [elements.pageEyebrow.textContent, elements.pageTitle.textContent] = titles[state.activeView] || ["", ""];
}

function syncNavigation() {
  for (const button of document.querySelectorAll("[data-view]")) {
    const isStudioSettings = button.dataset.view === "studio";
    const isActive = button.dataset.view === state.activeView
      && (!isStudioSettings || state.editorTab !== "media");
    button.classList.toggle("active", isActive);
  }
  for (const button of document.querySelectorAll("[data-studio-tab]")) {
    button.classList.toggle(
      "active",
      state.activeView === "studio" && button.dataset.studioTab === state.editorTab,
    );
  }
}

function valueAtPath(root, pathname) {
  return pathname.split(".").reduce((value, key) => value?.[key], root);
}

function setAtPath(root, pathname, value) {
  const keys = pathname.split(".");
  const finalKey = keys.pop();
  // Cree les niveaux manquants: un preset enregistre avant l'ajout de la fiche
  // persona n'a pas l'objet "persona", et ecrire dedans planterait au premier
  // caractere saisi.
  const target = keys.reduce((object, key) => {
    if (object[key] === undefined || object[key] === null) object[key] = {};
    return object[key];
  }, root);
  target[finalKey] = value;
}

function inputValue(input) {
  if (input.type === "checkbox") return input.checked;
  if (input.dataset.list === "lines") {
    return input.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }
  if (input.dataset.list === "commas") {
    return input.value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
  if (input.type === "number" || input.type === "range") {
    return Number(input.value);
  }
  return input.value;
}

function field({
  label,
  path,
  value,
  type = "text",
  options = [],
  full = false,
  help = "",
  rows = 4,
  className = "",
  list = "",
  min,
  max,
  step,
  readonly = false,
}) {
  let control;
  const data = `data-preset-path="${escapeHtml(path)}"`;
  if (path === "mainSettings.primaryLanguage") {
    type = "select";
    options = languageOptions;
  }
  if (path === "identity.language") {
    type = "select";
    options = identityLanguageOptions;
  }
  if (type === "textarea") {
    control = `<textarea ${data} rows="${rows}" ${list ? `data-list="${list}"` : ""} class="${className}">${escapeHtml(
      Array.isArray(value) ? value.join("\n") : value,
    )}</textarea>`;
  } else if (type === "select") {
    control = `<select ${data}>${options.map((option) => {
      const optionValue = typeof option === "string" ? option : option.value;
      const optionLabel = typeof option === "string" ? option : option.label;
      return `<option value="${escapeHtml(optionValue)}" ${
        optionValue === value ? "selected" : ""
      }>${escapeHtml(optionLabel)}</option>`;
    }).join("")}</select>`;
  } else if (type === "range") {
    control = `
      <div class="range-row">
        <input ${data} type="range" value="${escapeHtml(value)}" min="${min}" max="${max}" step="${step || 1}">
        <span class="range-value">${escapeHtml(value)}</span>
      </div>
    `;
  } else {
    control = `<input ${data} type="${type}" value="${escapeHtml(value)}" ${
      min !== undefined ? `min="${min}"` : ""
    } ${max !== undefined ? `max="${max}"` : ""} ${
      step !== undefined ? `step="${step}"` : ""
    } ${readonly ? "readonly" : ""}>`;
  }
  return `
    <div class="field ${full ? "full" : ""}">
      <label>${escapeHtml(label)}</label>
      ${control}
      ${help ? `<p class="field-help">${escapeHtml(help)}</p>` : ""}
    </div>
  `;
}

function toggle(label, path, checked, root = "preset") {
  const attribute = root === "preset" ? "data-preset-path" : "data-config-path";
  return `
    <label class="toggle-field">
      <span>${escapeHtml(label)}</span>
      <input type="checkbox" ${attribute}="${escapeHtml(path)}" ${checked ? "checked" : ""}>
    </label>
  `;
}

function presetToggleButton(label, path, checked, help = "") {
  return `
    <div class="toggle-button-card ${checked ? "active" : ""}">
      <div>
        <strong>${escapeHtml(label)}</strong>
        ${help ? `<small>${escapeHtml(help)}</small>` : ""}
      </div>
      <button
        type="button"
        class="state-toggle-button ${checked ? "active" : ""}"
        data-preset-toggle-path="${escapeHtml(path)}"
        aria-label="${escapeHtml(label)}"
        aria-pressed="${checked ? "true" : "false"}"
      ><span class="state-toggle-knob"></span></button>
    </div>
  `;
}

function renderPresetList() {
  const presets = visiblePresets();
  const chips = document.getElementById("preset-group-chips");
  if (chips) {
    chips.innerHTML = presetGroupChipsHtml();
    chips.onclick = (event) => {
      const button = event.target.closest("[data-group-filter]");
      if (!button) return;
      setPresetGroupFilter(button.dataset.groupFilter);
      // On deplace d'abord la selection dans le groupe choisi: visiblePresets() ferait sinon
      // suivre le filtre sur le preset encore ouvert et annulerait le choix.
      const visibles = activePresets().filter((preset) => presetGroupFilter === "all" || presetFilterOf(preset) === presetGroupFilter);
      if (visibles.length && !visibles.some((preset) => preset.id === state.selectedPresetId)) state.selectedPresetId = visibles[0].id;
      renderStudio();
    };
  }
  elements.presetList.size = Math.max(4, Math.min(12, presets.length + (presetGroupFilter === "all" ? 3 : 0)));
  elements.presetList.innerHTML = presetOptionsHtml(presets, state.selectedPresetId, undefined, presetGroupFilter !== "all");
  elements.presetList.value = state.selectedPresetId;
  elements.presetList.onchange = () => {
    state.selectedPresetId = elements.presetList.value;
    renderStudio();
  };
}

function renderIdentity(preset) {
  return `
    <section class="settings-band">
      <div class="band-heading">
        <div>
          <h3>Identité du preset</h3>
          <p>Nom interne et identité visible utilisée dans les réponses.</p>
        </div>
      </div>
      <div class="form-grid three">
        ${field({ label: "Nom du preset", path: "name", value: preset.name })}
        ${field({ label: "Identifiant", path: "id", value: preset.id, readonly: true, help: "Identifiant stable utilisé par le moteur." })}
        ${field({ label: "Langue", path: "identity.language", value: preset.identity.language, type: "select", options: [
          { value: "fr", label: "Français" },
          { value: "en", label: "Anglais" },
          { value: "auto", label: "Détection automatique" },
        ] })}
      </div>
    </section>
    <section class="settings-band">
      <div class="band-heading">
        <div>
          <h3>Personnage</h3>
          <p>Informations stables injectées dans chaque conversation.</p>
        </div>
      </div>
      <div class="form-grid three">
        ${field({ label: "Prénom", path: "identity.name", value: preset.identity.name })}
        ${field({ label: "Âge", path: "identity.age", value: preset.identity.age, type: "number", min: 18, max: 99 })}
        ${field({ label: "Ville", path: "identity.city", value: preset.identity.city, help: "Peut être remplacée par la ville du compte ChatNow." })}
        ${field({ label: "Genre", path: "identity.gender", value: preset.identity.gender })}
        ${field({ label: "Activité", path: "identity.occupation", value: preset.identity.occupation })}
        ${field({ label: "Centres d’intérêt", path: "identity.interests", value: preset.identity.interests })}
        ${field({ label: "Biographie et contexte", path: "identity.bio", value: preset.identity.bio, type: "textarea", full: true, rows: 4 })}
      </div>
    </section>
  `;
}

function renderStyle(preset) {
  return `
    <section class="settings-band">
      <div class="band-heading">
        <div>
          <h3>Voix conversationnelle</h3>
          <p>Règles appliquées à la rédaction de chaque message.</p>
        </div>
      </div>
      <div class="form-grid">
        ${field({ label: "Ton", path: "style.tone", value: preset.style.tone })}
        ${field({ label: "Vocabulaire", path: "style.vocabulary", value: preset.style.vocabulary })}
        ${field({ label: "Longueur des réponses", path: "style.responseLength", value: preset.style.responseLength, type: "select", options: [
          { value: "tres-court", label: "Très court" },
          { value: "court", label: "Court" },
          { value: "moyen", label: "Moyen" },
        ] })}
        ${field({ label: "Bulles maximum", path: "style.maxBubbles", value: preset.style.maxBubbles, type: "number", min: 1, max: 6 })}
        ${field({ label: "Niveau de fautes", path: "style.typoLevel", value: preset.style.typoLevel, type: "range", min: 0, max: 5 })}
        ${field({ label: "Niveau d’emojis", path: "style.emojiLevel", value: preset.style.emojiLevel, type: "range", min: 0, max: 5 })}
        ${field({ label: "Expressions interdites", path: "style.forbiddenPhrases", value: preset.style.forbiddenPhrases, type: "textarea", full: true, rows: 3, help: "Une expression par ligne ou séparées par des virgules." })}
      </div>
    </section>
    <section class="settings-band">
      <div class="band-heading">
        <div>
          <h3>Prompt système</h3>
          <p>Instructions permanentes. Le moteur ajoutera ensuite l’historique et la phase active.</p>
        </div>
      </div>
      <div class="form-grid">
        ${field({ label: "Instructions du personnage", path: "style.systemPrompt", value: preset.style.systemPrompt, type: "textarea", full: true, rows: 10, className: "prompt-editor" })}
      </div>
    </section>
  `;
}

const mediaSources = [
  { value: "none", label: "Aucun" },
  { value: "primary", label: "Principal" },
  { value: "sexy", label: "Sexy" },
  { value: "sad", label: "Triste" },
  { value: "happy", label: "Joyeux" },
  { value: "audio", label: "Audio" },
  { value: "specific", label: "Spécifique" },
];

const objectionCtaTimingOptions = [
  { value: "both", label: "Avant et apres CTA" },
  { value: "before_cta", label: "Avant CTA seulement" },
  { value: "after_cta", label: "Apres CTA seulement" },
];

const platformOptions = [
  { value: "snap", label: "Snapchat (auto)" },
  "OnlyFans",
  "Phone Number",
  "Telegram",
  "Fansly",
  "Chaturbate",
  "I Want Clips",
  "Fanplace",
  "Premium Snapchat",
  "MYM",
  "AVN Stars",
  "Fanvue",
  "4Based",
  "FetLife",
  "Feet Finder",
  "Patreon",
  "FanCentro",
  "UVIU",
  "Loyal Fans",
  "Just For Fans",
  "FlirtingFans",
  "Many Vids",
  "Uncove",
  "Clips4Sale",
  "Unlockd",
  "FanTime",
  "Ifans",
  "Unfiltrd",
  "Other",
];

function selectMarkup(path, value, options) {
  return `
    <select class="compact-input" data-preset-path="${escapeHtml(path)}">
      ${options.map((option) => {
        const optionValue = typeof option === "string" ? option : option.value;
        const optionLabel = typeof option === "string" ? option : option.label;
        return `<option value="${escapeHtml(optionValue)}" ${
          optionValue === value ? "selected" : ""
        }>${escapeHtml(optionLabel)}</option>`;
      }).join("")}
    </select>
  `;
}

function renderOptimizations(preset) {
  const issues = [];
  const urls = preset.urls.items.filter((item) => item.enabled && item.url.trim());
  const openerCount = preset.openers.items.reduce(
    (total, opener) => total + opener.messages.length,
    0,
  );
  const phases = preset.cycles.reduce(
    (total, cycle) => total + cycle.phases.length,
    0,
  );
  if (!urls.length) {
    issues.push(["urgent", "Aucune URL active", "Ajoute au moins une URL pour permettre l’envoi du CTA."]);
  }
  if (!phases) {
    issues.push(["urgent", "Aucune phase", "Le moteur a besoin d’au moins une phase conversationnelle."]);
  }
  if (openerCount < 10) {
    issues.push(["important", `Seulement ${openerCount} bulles d’ouverture`, "Ajoute davantage de variantes pour réduire les répétitions."]);
  }
  if (preset.objections.filter((item) => item.enabled).length < 3) {
    issues.push(["important", "Peu d’objections configurées", "Prépare les réponses aux blocages les plus fréquents."]);
  }
  if (!preset.followups.enabled) {
    issues.push(["optional", "Relances désactivées", "Les conversations silencieuses ne seront pas relancées."]);
  }
  if (!preset.media.categories.length) {
    issues.push(["optional", "Aucune catégorie média", "Classe les médias pour permettre une sélection contextuelle."]);
  }
  return `
    <section class="settings-band">
      <div class="band-heading">
        <div>
          <h3>Audit du preset</h3>
          <p>Recommandations calculées à partir de la configuration actuelle.</p>
        </div>
        <span class="audit-score">${issues.length ? `${issues.length} points` : "Prêt"}</span>
      </div>
      <div class="optimization-list">
        ${issues.length ? issues.map(([level, title, detail]) => `
          <article class="optimization-item ${level}">
            <span>${level === "urgent" ? "Prioritaire" : level === "important" ? "Recommandé" : "Optionnel"}</span>
            <div>
              <strong>${escapeHtml(title)}</strong>
              <p>${escapeHtml(detail)}</p>
            </div>
          </article>
        `).join("") : `
          <article class="optimization-item success">
            <span>OK</span>
            <div><strong>Configuration cohérente</strong><p>Aucun blocage détecté.</p></div>
          </article>
        `}
      </div>
    </section>
  `;
}

function mediaVaultField(preset) {
  const vaults = state.mediaLibrary?.vaults || [];
  const currentVaultId = preset.media?.vaultId || "";
  if (vaults.length) {
    const options = [
      { value: "", label: "Aucun Media Vault" },
      ...vaults.map((vault) => ({
        value: vault.id,
        label: `${vault.name} (${vault.id})`,
      })),
    ];
    if (currentVaultId && !vaults.some((vault) => vault.id === currentVaultId)) {
      options.push({
        value: currentVaultId,
        label: `${currentVaultId} (non cree)`,
      });
    }
    return field({
      label: "Media Vault photos",
      path: "media.vaultId",
      value: currentVaultId,
      type: "select",
      options,
      help: "Optionnel. Le preset garde sa config ecrite; les photos viennent seulement du vault choisi ici.",
    });
  }
  return field({
    label: "Media Vault photos",
    path: "media.vaultId",
    value: currentVaultId,
    help: "Cree un Media Vault dans l'onglet Media Vault, puis choisis-le ici si ce preset doit utiliser ses photos.",
  });
}

// Section repliable des Main Settings. <details>/<summary> natif: l'ouverture
// est geree par le navigateur, sans JS. L'etat est memorise par section dans
// localStorage, sinon chaque re-render rouvrirait tout et on perdrait sa place
// en pleine edition.
function band(id, title, description, body) {
  let open = true;
  try {
    const stored = localStorage.getItem(`bmb-band-${id}`);
    if (stored !== null) open = stored === "1";
  } catch (_) { /* mode prive: on garde le defaut ouvert */ }
  return `
    <details class="settings-band" data-band="${id}"${open ? " open" : ""}>
      <summary class="band-heading">
        <div>
          <h3>${title}</h3>
          ${description ? `<p>${description}</p>` : ""}
        </div>
        <span class="band-chevron" aria-hidden="true"></span>
      </summary>
      <div class="band-body">${body}</div>
    </details>`;
}

// Sections persona generees depuis la fiche detaillee. Chaque champ est
// libre; vide = non injecte dans le prompt.
function renderPersonaBands(preset) {
  const p = preset.persona || {};
  return [
    band("persona-identite", "Identity and basics", "Who she is: looks, origin, languages.", `
      <div class="form-grid three">
        ${field({ label: "Physical description", path: "persona.identite.descriptionPhysique", value: (p.identite||{}).descriptionPhysique || "", type: "textarea", rows: 3, full: true })}
        ${field({ label: "Shoe size", path: "persona.identite.pointure", value: (p.identite||{}).pointure || "" })}
        ${field({ label: "Date of birth", path: "persona.identite.dateDeNaissance", value: (p.identite||{}).dateDeNaissance || "" })}
        ${field({ label: "Height (m)", path: "persona.identite.tailleM", value: (p.identite||{}).tailleM || "" })}
        ${field({ label: "Weight (kg)", path: "persona.identite.poidsKg", value: (p.identite||{}).poidsKg || "" })}
        ${field({ label: "Country", path: "persona.identite.pays", value: (p.identite||{}).pays || "" })}
        ${field({ label: "City", path: "persona.identite.ville", value: (p.identite||{}).ville || "", type: "textarea", rows: 3, full: true })}
        ${field({ label: "Occupation", path: "persona.identite.profession", value: (p.identite||{}).profession || "", type: "textarea", rows: 3, full: true })}
        ${field({ label: "Eye color", path: "persona.identite.couleurDesYeux", value: (p.identite||{}).couleurDesYeux || "" })}
        ${field({ label: "Hair color", path: "persona.identite.couleurDesCheveux", value: (p.identite||{}).couleurDesCheveux || "" })}
        ${field({ label: "Bust size", path: "persona.identite.tailleDePoitrine", value: (p.identite||{}).tailleDePoitrine || "" })}
        ${field({ label: "Living situation", path: "persona.identite.lieuDeVie", value: (p.identite||{}).lieuDeVie || "", type: "textarea", rows: 3, full: true })}
      </div>`),
    band("persona-modeDeVie", "Lifestyle", "Habits and daily life.", `
      <div class="form-grid three">
        ${field({ label: "Smoking habits", path: "persona.modeDeVie.habitudeDeFumer", value: (p.modeDeVie||{}).habitudeDeFumer || "" })}
        ${field({ label: "Drinking habits", path: "persona.modeDeVie.consommationDalcool", value: (p.modeDeVie||{}).consommationDalcool || "" })}
        ${field({ label: "Travel", path: "persona.modeDeVie.voyages", value: (p.modeDeVie||{}).voyages || "", type: "textarea", rows: 3, full: true })}
        ${field({ label: "Pets", path: "persona.modeDeVie.animauxDeCompagnie", value: (p.modeDeVie||{}).animauxDeCompagnie || "", type: "textarea", rows: 3, full: true })}
        ${field({ label: "Favorite car", path: "persona.modeDeVie.voiturePreferee", value: (p.modeDeVie||{}).voiturePreferee || "", type: "textarea", rows: 3, full: true })}
      </div>`),
    band("persona-preferences", "Preferences", "Tastes: music, movies, food, passions.", `
      <div class="form-grid three">
        ${field({ label: "Favorite color", path: "persona.preferences.couleurPreferee", value: (p.preferences||{}).couleurPreferee || "" })}
        ${field({ label: "Least favorite color", path: "persona.preferences.couleurLaMoinsAimee", value: (p.preferences||{}).couleurLaMoinsAimee || "" })}
        ${field({ label: "Passions", path: "persona.preferences.passions", value: (p.preferences||{}).passions || "", type: "textarea", rows: 3, full: true })}
        ${field({ label: "Favorite food", path: "persona.preferences.platsPreferes", value: (p.preferences||{}).platsPreferes || "", type: "textarea", rows: 3, full: true })}
        ${field({ label: "Least favorite food", path: "persona.preferences.platsLesMoinsAimes", value: (p.preferences||{}).platsLesMoinsAimes || "", type: "textarea", rows: 3, full: true })}
        ${field({ label: "Religion", path: "persona.preferences.religion", value: (p.preferences||{}).religion || "", type: "textarea", rows: 3, full: true })}
        ${field({ label: "Favorite music genres", path: "persona.preferences.genresMusicauxPreferes", value: (p.preferences||{}).genresMusicauxPreferes || "", type: "textarea", rows: 3, full: true })}
        ${field({ label: "Favorite movies", path: "persona.preferences.filmsPreferes", value: (p.preferences||{}).filmsPreferes || "", type: "textarea", rows: 3, full: true })}
        ${field({ label: "Favorite celebrities", path: "persona.preferences.celebritesPreferees", value: (p.preferences||{}).celebritesPreferees || "", type: "textarea", rows: 3, full: true })}
        ${field({ label: "Favorite characters", path: "persona.preferences.personnagesPreferes", value: (p.preferences||{}).personnagesPreferes || "", type: "textarea", rows: 3, full: true })}
        ${field({ label: "Favorite books", path: "persona.preferences.livresPreferes", value: (p.preferences||{}).livresPreferes || "", type: "textarea", rows: 3, full: true })}
      </div>`),
    band("persona-relations", "Relationships", "Status, ideal partner.", `
      <div class="form-grid three">
        ${field({ label: "Relationship status", path: "persona.relations.statutRelationnel", value: (p.relations||{}).statutRelationnel || "" })}
        ${field({ label: "Family situation / children", path: "persona.relations.situationFamilialeEnfants", value: (p.relations||{}).situationFamilialeEnfants || "", type: "textarea", rows: 3, full: true })}
        ${field({ label: "Number of sexual partners", path: "persona.relations.nombreDePartenairesSexuels", value: (p.relations||{}).nombreDePartenairesSexuels || "" })}
        ${field({ label: "Ideal partner", path: "persona.relations.partenaireIdeal", value: (p.relations||{}).partenaireIdeal || "", type: "textarea", rows: 3, full: true })}
        ${field({ label: "Ideal date", path: "persona.relations.rendezVousIdeal", value: (p.relations||{}).rendezVousIdeal || "", type: "textarea", rows: 3, full: true })}
      </div>`),
  ].join("");
}

function renderMainSettings(preset) {
  return `
    ${band("personnage", "Character and context", "Information the engine injects into every conversation.", `<div class="form-grid three">
        ${field({ label: "Preset name", path: "name", value: preset.name })}
        ${field({ label: "Preset ID", path: "id", value: preset.id, readonly: true, help: "Identifiant stable du preset." })}
        <div class="field">
          <label>Group</label>
          <select data-preset-group-select>${presetGroupChoicesHtml(presetGroupOf(preset))}</select>
          <p class="field-help">Assign this preset to a group, or create one. The group filter above the list shows one group at a time.</p>
        </div>
        ${mediaVaultField(preset)}
        ${field({ label: "First name", path: "identity.name", value: preset.identity.name })}
        ${field({ label: "Age", path: "identity.age", value: preset.identity.age, type: "number", min: 18, max: 99 })}
        ${field({ label: "City", path: "identity.city", value: preset.identity.city })}
        ${field({ label: "Discovery platform", path: "mainSettings.discoveryPlatform", value: preset.mainSettings.discoveryPlatform })}
        ${field({ label: "Style", path: "mainSettings.chattingStyle", value: preset.mainSettings.chattingStyle, type: "select", options: [
          { value: "youthful", label: "Youthful / Gen-Z" },
          { value: "mature", label: "Mature" },
        ] })}
        ${field({ label: "Appearance", path: "mainSettings.appearance", value: preset.mainSettings.appearance, type: "textarea", full: true, rows: 3 })}
        ${field({ label: "Interests and hobbies", path: "identity.interests", value: preset.identity.interests, type: "textarea", rows: 3 })}
        ${field({ label: "CTA information", path: "mainSettings.ctaInfo", value: preset.mainSettings.ctaInfo, type: "textarea", rows: 3 })}
        ${field({ label: "Daytime activity", path: "mainSettings.dayActivity", value: preset.mainSettings.dayActivity, type: "textarea", rows: 3 })}
        ${field({ label: "Night activity", path: "mainSettings.nightActivity", value: preset.mainSettings.nightActivity, type: "textarea", rows: 3 })}
      </div>`)}
    ${renderPersonaBands(preset)}
    ${band("langues", "Languages and writing", "Detection, allowed languages and natural text.", `<div class="form-grid three">
        ${field({ label: "Primary language", path: "mainSettings.primaryLanguage", value: preset.mainSettings.primaryLanguage })}
        ${field({ label: "Additional languages", path: "mainSettings.additionalLanguages", value: preset.mainSettings.additionalLanguages.join(", "), type: "textarea", rows: 2, list: "commas" })}
        ${field({ label: "Typo level (%)", path: "mainSettings.typoPercent", value: preset.mainSettings.typoPercent, type: "range", min: 0, max: 100, help: "0 = texte propre, 30 = naturel avec quelques fautes, 100 = beaucoup de fautes." })}
        <div class="field">
          <label>Detail Vision</label>
          <select data-config-path="engine.visionDetail">
            <option value="low" ${(state.config?.engine?.visionDetail || "low") === "low" ? "selected" : ""}>Low - moins cher</option>
            <option value="auto" ${["auto", "medium"].includes(state.config?.engine?.visionDetail) ? "selected" : ""}>Auto - equilibre</option>
            <option value="high" ${state.config?.engine?.visionDetail === "high" ? "selected" : ""}>High - plus precis</option>
          </select>
          <p class="field-help">Regle la precision de l'analyse OpenAI des images recues.</p>
        </div>
      </div>
      <div class="toggle-grid">
        ${toggle("Detect language", "mainSettings.detectLanguage", preset.mainSettings.detectLanguage)}
        ${toggle("Match their location", "mainSettings.matchLocation", preset.mainSettings.matchLocation)}
        ${toggle("Use ChatNow account city", "mainSettings.useAccountLocation", preset.mainSettings.useAccountLocation)}
        ${toggle("AI voice notes", "mainSettings.aiVoiceNotes", preset.mainSettings.aiVoiceNotes)}
        ${toggle("Random media", "mainSettings.selectMediaRandomly", preset.mainSettings.selectMediaRandomly)}
      </div>`)}
    ${band("filtres", "Filters and advanced settings", "Guards applied before any model call.", `<div class="form-grid three">
        ${field({ label: "Multi-account delay (days)", path: "mainSettings.multiAccountDelayDays", value: preset.mainSettings.multiAccountDelayDays, type: "number", min: 0, max: 365 })}
        ${field({ label: "Country filter", path: "mainSettings.countryTierFilter", value: preset.mainSettings.countryTierFilter, type: "select", options: [
          { value: "off", label: "Disabled" },
          { value: "t3", label: "Filter Tier 3" },
          { value: "t2", label: "Filter Tier 2 and 3" },
          { value: "t1", label: "Tier 1 only" },
        ] })}
        ${field({ label: "Character gender", path: "mainSettings.characterGender", value: preset.mainSettings.characterGender, type: "select", options: [
          { value: "female", label: "Female" },
          { value: "male", label: "Male" },
          { value: "neutral", label: "Neutral" },
        ] })}
        ${field({ label: "Advanced style rules", path: "mainSettings.advancedChattingStyle", value: preset.mainSettings.advancedChattingStyle, type: "textarea", full: true, rows: 4 })}
        ${field({ label: "BambouAI system prompt", path: "style.systemPrompt", value: preset.style.systemPrompt, type: "textarea", full: true, rows: 8, className: "prompt-editor" })}
      </div>
      <div class="toggle-grid">
        ${toggle("Filtrer les femmes", "mainSettings.filterFemales", preset.mainSettings.filterFemales)}
        ${toggle("Ignorer les timewasters connus", "mainSettings.ignoreKnownTimewasters", preset.mainSettings.ignoreKnownTimewasters)}
        ${toggle("Anti-répétition", "behavior.antiRepeat", preset.behavior.antiRepeat)}
      </div>`)}
  `;
}

function renderOpeners(preset) {
  return renderOpenersCapital(preset);

  return `
    <section class="settings-band">
      <div class="band-heading">
        <div><h3>Openers</h3><p>Configure opener messages sent to greet new followers/adds.</p></div>
        ${toggle("Activer", "openers.enabled", preset.openers.enabled)}
      </div>
      <div class="config-block-list">
        ${preset.openers.items.map((item, index) => `
          <article class="config-block">
            <div class="config-block-head">
              <strong>Opener ${index + 1}</strong>
              <button type="button" class="remove-row" data-remove-opener="${index}" aria-label="Supprimer">×</button>
            </div>
            <div class="form-grid">
              ${field({ label: "Titre", path: `openers.items.${index}.title`, value: item.title })}
              ${field({ label: "Source média", path: `openers.items.${index}.mediaSource`, value: item.mediaSource, type: "select", options: mediaSources })}
              ${field({ label: "Messages", path: `openers.items.${index}.messages`, value: item.messages, type: "textarea", full: true, rows: 4, list: "lines", help: "Une ligne = une bulle." })}
            </div>
          </article>
        `).join("")}
      </div>
      <button type="button" class="button secondary add-row" id="add-opener">Ajouter un opener</button>
    </section>
  `;
}

function removeCycle(preset, cycleIndex) {
  if (!Array.isArray(preset.cycles) || preset.cycles.length <= 1) return false;
  const removedNumber = cycleIndex + 1;
  preset.cycles.splice(cycleIndex, 1);

  for (const cta of preset.ctaScripts || []) {
    const cycleNumber = Number(cta.cycle || 1);
    if (cycleNumber === removedNumber) {
      cta.cycle = Math.min(removedNumber, preset.cycles.length);
    } else if (cycleNumber > removedNumber) {
      cta.cycle = cycleNumber - 1;
    }
  }

  state.activeCycleIndex = Math.min(Math.max(0, cycleIndex - 1), preset.cycles.length - 1);
  state.expandedPhaseKey = "";
  return true;
}

function movePhase(preset, cycleIndex, fromIndex, toIndex) {
  const phases = preset.cycles?.[cycleIndex]?.phases;
  if (!Array.isArray(phases)) return false;
  if (fromIndex < 0 || fromIndex >= phases.length) return false;
  const boundedToIndex = Math.max(0, Math.min(toIndex, phases.length - 1));
  if (fromIndex === boundedToIndex) return false;

  const [phase] = phases.splice(fromIndex, 1);
  phases.splice(boundedToIndex, 0, phase);
  state.expandedPhaseKey = `${cycleIndex}:${boundedToIndex}`;
  return true;
}

function togglePhaseDetails(phaseKey) {
  state.expandedPhaseKey = state.expandedPhaseKey === phaseKey ? "" : phaseKey;
  renderEditor();
}

function renderCycles(preset) {
  const totalCycles = Math.max(1, preset.cycles.length);
  state.activeCycleIndex = Math.min(
    Math.max(Number(state.activeCycleIndex || 0), 0),
    totalCycles - 1,
  );
  const cycleIndex = state.activeCycleIndex;
  const cycle = preset.cycles[cycleIndex] || preset.cycles[0] || {
    name: "Cycle 1",
    smartPacing: true,
    phases: [],
  };
  const activeUrlItem = preset.urls.items.find((item) => item.enabled && (item.url || item.platform === "snap"))
    || preset.urls.items[0];
  const activeUrl = (activeUrlItem?.platform === "snap"
    ? resolveSnapHandlePreview(activeUrlItem.snapModel)
    : activeUrlItem?.url)
    || "Aucune URL configuree";
  const ctaCount = preset.ctaScripts.reduce(
    (total, cta) => total + cta.messages.length,
    0,
  );

  return `
    <section class="phases-screen">
      <div class="phases-title">
        <h3>Chatting Phases</h3>
        <p>Define conversation flow stages with specific goals and transitions</p>
      </div>

      <div class="smart-pacing-card">
        <div class="smart-pacing-title">
          <strong>Smart Pacing (Recommended)</strong>
          <span title="If enabled, AI uses phases as a guideline but still has the freedom to extend phases, switch phases, start phases earlier and delay CTA sending if the vibe is not right. Disable to make AI strictly follow the exchange count in each phase.">?</span>
        </div>
        ${toggle("", `cycles.${cycleIndex}.smartPacing`, cycle.smartPacing)}
      </div>

      <div class="cycle-toolbar">
        <div class="cycle-tabs">
          ${preset.cycles.map((item, index) => `
            <button type="button" class="cycle-tab ${index === cycleIndex ? "active" : ""}" data-cycle-index="${index}">
              ${escapeHtml(item.name || `Cycle ${index + 1}`)}
            </button>
          `).join("")}
        </div>
        <div class="cycle-actions">
          <button type="button" class="cycle-icon-button" id="add-cycle" title="Ajouter un cycle" aria-label="Ajouter un cycle">+</button>
          <button type="button" class="cycle-icon-button" id="remove-cycle" title="Supprimer le cycle" aria-label="Supprimer le cycle" ${preset.cycles.length <= 1 ? "disabled" : ""}>-</button>
        </div>
      </div>

      <div class="phase-card-list">
        ${(cycle.phases || []).map((phase, phaseIndex) => {
          const phaseKey = `${cycleIndex}:${phaseIndex}`;
          const expanded = state.expandedPhaseKey === phaseKey;
          return `
            <article class="phase-card ${expanded ? "expanded" : ""}" data-phase-card="${phaseKey}" data-cycle-index="${cycleIndex}" data-phase-index="${phaseIndex}">
              <div class="phase-card-head">
                <span class="drag-handle" draggable="true" data-phase-drag="${phaseKey}" title="Deplacer la phase" aria-hidden="true">::</span>
                <strong>${escapeHtml(phase.name || `Phase ${phaseIndex + 1}`)}</strong>
                <button type="button" class="phase-card-icon danger" data-remove-cycle-phase="${cycleIndex}:${phaseIndex}" aria-label="Supprimer">X</button>
                <button type="button" class="phase-card-icon phase-toggle-button" data-toggle-phase-details="${phaseKey}" aria-label="${expanded ? "Masquer les details" : "Afficher les details"}">${expanded ? "^" : "v"}</button>
              </div>
              <div class="phase-details" data-phase-details="${phaseKey}">
                <div class="form-grid three">
                  ${field({ label: "Phase", path: `cycles.${cycleIndex}.phases.${phaseIndex}.name`, value: phase.name })}
                  ${field({ label: "Echanges", path: `cycles.${cycleIndex}.phases.${phaseIndex}.exchanges`, value: phase.exchanges, type: "number", min: 1, max: 100 })}
                  ${field({ label: "Interet", path: `cycles.${cycleIndex}.phases.${phaseIndex}.interestLevel`, value: phase.interestLevel, type: "select", options: [
                    { value: "low", label: "Faible" },
                    { value: "medium", label: "Moyen" },
                    { value: "high", label: "Eleve" },
                  ] })}
                  ${field({ label: "Media %", path: `cycles.${cycleIndex}.phases.${phaseIndex}.mediaProbability`, value: phase.mediaProbability, type: "number", min: 0, max: 100 })}
                  ${field({ label: "Source media", path: `cycles.${cycleIndex}.phases.${phaseIndex}.mediaSource`, value: phase.mediaSource, type: "select", options: mediaSources })}
                  ${field({ label: "Objectif", path: `cycles.${cycleIndex}.phases.${phaseIndex}.objective`, value: phase.objective, type: "textarea", full: true, rows: 3 })}
                </div>
              </div>
            </article>
          `;
        }).join("") || `<div class="empty-state">Aucune phase dans ce cycle.</div>`}
      </div>

      <button type="button" class="phase-add-button" data-add-cycle-phase="${cycleIndex}">+ Add Phase</button>

      <div class="phase-shortcuts">
        <button type="button" class="phase-shortcut-card" data-open-editor-tab="cta">
          <span class="shortcut-icon">O</span>
          <span><strong>Call-To-Action</strong><em>${ctaCount} CTAs configured</em></span>
          <b>&gt;</b>
        </button>
        <button type="button" class="phase-shortcut-card" data-open-editor-tab="urls">
          <span class="shortcut-icon">L</span>
          <span><strong>URLs</strong><em>${escapeHtml(activeUrl)}</em></span>
          <b>&gt;</b>
        </button>
      </div>
    </section>
  `;

}

/*
  return `
    ${preset.cycles.map((cycle, cycleIndex) => `
      <section class="settings-band">
        <div class="band-heading">
          <div><h3>${escapeHtml(cycle.name)}</h3><p>Phases et objectifs de ce cycle.</p></div>
          ${toggle("Smart Pacing", `cycles.${cycleIndex}.smartPacing`, cycle.smartPacing)}
        </div>
        <div class="repeater-list">
          ${cycle.phases.map((phase, phaseIndex) => `
            <div class="phase-grid">
              <div class="compact-field"><label>Phase</label><input class="compact-input" data-preset-path="cycles.${cycleIndex}.phases.${phaseIndex}.name" value="${escapeHtml(phase.name)}"></div>
              <div class="compact-field"><label>Objectif</label><input class="compact-input" data-preset-path="cycles.${cycleIndex}.phases.${phaseIndex}.objective" value="${escapeHtml(phase.objective)}"></div>
              <div class="compact-field"><label>Échanges</label><input class="compact-input" type="number" min="1" max="100" data-preset-path="cycles.${cycleIndex}.phases.${phaseIndex}.exchanges" value="${phase.exchanges}"></div>
              <div class="compact-field"><label>Intérêt</label>${selectMarkup(`cycles.${cycleIndex}.phases.${phaseIndex}.interestLevel`, phase.interestLevel, [
                { value: "low", label: "Faible" },
                { value: "medium", label: "Moyen" },
                { value: "high", label: "Élevé" },
              ])}</div>
              <div class="compact-field"><label>Média %</label><input class="compact-input" type="number" min="0" max="100" data-preset-path="cycles.${cycleIndex}.phases.${phaseIndex}.mediaProbability" value="${phase.mediaProbability}"></div>
              <div class="compact-field"><label>Source</label>${selectMarkup(`cycles.${cycleIndex}.phases.${phaseIndex}.mediaSource`, phase.mediaSource, mediaSources)}</div>
              <button type="button" class="remove-row" data-remove-cycle-phase="${cycleIndex}:${phaseIndex}" aria-label="Supprimer">×</button>
            </div>
          `).join("")}
        </div>
        <button type="button" class="button secondary add-row" data-add-cycle-phase="${cycleIndex}">Ajouter une phase</button>
      </section>
    `).join("")}
    <section class="settings-band">
      <button type="button" class="button secondary" id="add-cycle">Ajouter un cycle</button>
    </section>
  `;
}
*/

function renderCtaScripts(preset) {
  return `
    <section class="settings-band">
      <div class="band-heading"><div><h3>Scripts Call-to-Action</h3><p>Les messages sont envoyés dans l’ordre; chaque étape peut attendre une réponse.</p></div></div>
      <div class="config-block-list">
        ${preset.ctaScripts.map((cta, ctaIndex) => `
          <article class="config-block">
            <div class="config-block-head">
              <strong>CTA ${ctaIndex + 1}</strong>
              <button type="button" class="remove-row" data-remove-cta="${ctaIndex}" aria-label="Supprimer">×</button>
            </div>
            <div class="form-grid">
              ${field({ label: "Titre", path: `ctaScripts.${ctaIndex}.title`, value: cta.title })}
              ${field({ label: "Cycle", path: `ctaScripts.${ctaIndex}.cycle`, value: cta.cycle, type: "number", min: 1, max: Math.max(1, preset.cycles.length) })}
            </div>
            <div class="message-step-list">
              ${cta.messages.map((message, messageIndex) => `
                <div class="message-step">
                  <div class="compact-field"><label>Message ${messageIndex + 1}</label><textarea class="compact-input compact-area" data-preset-path="ctaScripts.${ctaIndex}.messages.${messageIndex}.text">${escapeHtml(message.text)}</textarea></div>
                  ${toggle("Attendre la réponse", `ctaScripts.${ctaIndex}.messages.${messageIndex}.waitForReply`, message.waitForReply)}
                  <div class="compact-field"><label>Source média</label>${selectMarkup(`ctaScripts.${ctaIndex}.messages.${messageIndex}.mediaSource`, message.mediaSource, mediaSources)}</div>
                  <button type="button" class="remove-row" data-remove-cta-message="${ctaIndex}:${messageIndex}" aria-label="Supprimer">×</button>
                </div>
              `).join("")}
            </div>
            <button type="button" class="button secondary add-row" data-add-cta-message="${ctaIndex}">Ajouter un message</button>
          </article>
        `).join("")}
      </div>
      <button type="button" class="button secondary add-row" id="add-cta">Ajouter un CTA</button>
    </section>
  `;
}

function renderOpenersCapital(preset) {
  const items = Array.isArray(preset.openers?.items) ? preset.openers.items : [];
  const mediaPoolOptions = [
    { value: "none", label: "None" },
    { value: "primary", label: "Primary" },
    { value: "sexy", label: "Sexy" },
    { value: "sad", label: "Sad" },
    { value: "happy", label: "Happy" },
    { value: "specific", label: "Specific" },
  ];
  return `
    <section class="capital-config-panel opener-config-panel">
      <div class="opener-top">
        <div class="opener-title-block">
          <h3>Openers</h3>
          <p>Configure opener messages sent to greet new followers/adds</p>
        </div>
        <label class="capital-toggle-switch" aria-label="Enable Openers">
          <input type="checkbox" data-preset-path="openers.enabled" ${preset.openers?.enabled ? "checked" : ""}>
          <span></span>
        </label>
      </div>

      <div class="opener-enable-copy">
        <strong>Enable Openers:</strong>
        <small>Enable this to automatically send opener messages to new followers/adds</small>
      </div>

      <div class="opener-enable-copy" style="border-top:1px solid #e6e6df;margin-top:8px;padding-top:12px;">
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
          <input type="checkbox" data-preset-path="openers.forceOpener" ${preset.openers?.forceOpener ? "checked" : ""}>
          <strong>Forcer l'opener</strong>
        </label>
        <small>Envoyer l'opener même si l'inconnu a déjà écrit (2ᵉ message). Appliqué sur toutes les plateformes de chat aléatoire de ce persona (omegleweb, chatrandom, chitchat, chatiw…).</small>
      </div>

      <div class="opener-card-list">
        ${items.map((item, index) => {
          const openerKey = String(index);
          const collapsed = state.collapsedOpenerKeys.has(openerKey);
          return `
          <article class="opener-card ${collapsed ? "collapsed" : ""}">
            <div class="opener-card-head">
              <input class="opener-title-input" data-preset-path="openers.items.${index}.title" value="${escapeHtml(item.title || `Opener ${index + 1}`)}" aria-label="Opener title">
              <div class="opener-card-actions">
                <button type="button" class="opener-icon-button danger" data-remove-opener="${index}" aria-label="Supprimer" title="Supprimer">X</button>
                <button type="button" class="opener-icon-button" data-toggle-opener-details="${openerKey}" aria-label="Replier" title="Replier">${collapsed ? "^" : "v"}</button>
              </div>
            </div>

            <div class="opener-card-body">
              <div class="capital-message-label">
                <strong>Messages:</strong>
                <small>Add multiple messages. The bot will send them in sequence as individual text bubbles.</small>
              </div>

              <div class="capital-message-list opener-message-list">
                ${(Array.isArray(item.messages) ? item.messages : [""]).map((message, messageIndex) => `
                  <div class="capital-message-row opener-message-row">
                    <textarea class="compact-input capital-message-input opener-message-input" data-preset-path="openers.items.${index}.messages.${messageIndex}">${escapeHtml(message)}</textarea>
                    <button type="button" class="opener-icon-button danger" data-remove-opener-message="${index}:${messageIndex}" aria-label="Supprimer le message" title="Supprimer">X</button>
                  </div>
                `).join("")}
              </div>

              <button type="button" class="button secondary opener-add-message" data-add-opener-message="${index}">+ Add message</button>

              <div class="opener-media-pool">
                <strong>Media Pool:</strong>
                <div class="media-pool-grid">
                  ${mediaPoolOptions.map((option) => `
                    <label class="media-pool-option">
                      <input
                        type="radio"
                        name="opener-media-${index}"
                        data-preset-path="openers.items.${index}.mediaSource"
                        value="${escapeHtml(option.value)}"
                        ${(item.mediaSource || "none") === option.value ? "checked" : ""}
                      >
                      <span>${escapeHtml(option.label)}</span>
                    </label>
                  `).join("")}
                </div>
                <small>Choose a media pool from which the bot will randomly select an image, or select specific images</small>
              </div>
            </div>
          </article>
        `;
        }).join("") || `<div class="empty-state">Aucun opener configure.</div>`}
      </div>

      <button type="button" class="button secondary opener-add-card" id="add-opener">+ Add Opener</button>
    </section>
  `;
}

function renderCtaScriptsCapital(preset) {
  const scripts = Array.isArray(preset.ctaScripts) ? preset.ctaScripts : [];
  const cycles = Array.isArray(preset.cycles) ? preset.cycles : [];
  const totalCycles = Math.max(1, cycles.length);
  state.activeCycleIndex = Math.min(
    Math.max(Number(state.activeCycleIndex || 0), 0),
    totalCycles - 1,
  );
  const cycleIndex = state.activeCycleIndex;
  const cycleOptions = cycles.map((cycle, index) => ({
    value: index + 1,
    label: cycle.name || `Cycle ${index + 1}`,
  }));
  // N'affiche que les CTA du cycle actif; on garde l'index d'origine pour les
  // chemins data-preset-path / suppression.
  const cycleScripts = scripts
    .map((cta, ctaIndex) => ({ cta, ctaIndex }))
    .filter(({ cta }) => Number(cta.cycle || 1) === cycleIndex + 1);
  return `
    <section class="cta-screen">
      <div class="cta-title">
        <h3>Call-To-Action Scripts</h3>
        <p>Configure CTA messages to convert conversations</p>
      </div>

      <div class="cycle-toolbar">
        <div class="cycle-tabs">
          ${(cycles.length ? cycles : [{ name: "Cycle 1" }]).map((item, index) => `
            <button type="button" class="cycle-tab ${index === cycleIndex ? "active" : ""}" data-cycle-index="${index}">
              ${escapeHtml(item.name || `Cycle ${index + 1}`)}
            </button>
          `).join("")}
        </div>
      </div>

      <div class="cta-card-list">
        ${cycleScripts.map(({ cta, ctaIndex }) => {
          const ctaKey = String(ctaIndex);
          const expanded = state.expandedCtaKey === ctaKey;
          const messages = Array.isArray(cta.messages) ? cta.messages : [];
          return `
        <article class="cta-card ${expanded ? "expanded" : ""}">
          <div class="cta-card-head">
            <div class="cta-title-line">
              <strong>${escapeHtml(cta.title || `CTA ${ctaIndex + 1}`)}</strong>
            </div>
            <button type="button" class="objection-card-icon danger" data-remove-cta="${ctaIndex}" aria-label="Supprimer">X</button>
            <button type="button" class="objection-card-icon" data-toggle-cta-details="${ctaKey}" aria-label="Afficher les details">${expanded ? "^" : "v"}</button>
          </div>

          <div class="cta-details">
            <div class="cta-settings-grid">
              ${field({ label: "Titre", path: `ctaScripts.${ctaIndex}.title`, value: cta.title || `CTA ${ctaIndex + 1}` })}
              <div class="field">
                <label>Cycle</label>
                ${selectMarkup(`ctaScripts.${ctaIndex}.cycle`, Number(cta.cycle || 1), cycleOptions.length ? cycleOptions : [{ value: 1, label: "Cycle 1" }])}
              </div>
              <label class="capital-inline-toggle">
                <span>Active</span>
                <input type="checkbox" data-preset-path="ctaScripts.${ctaIndex}.enabled" ${cta.enabled === false ? "" : "checked"}>
              </label>
              <label class="capital-inline-toggle">
                <span>Use default URL</span>
                <input type="checkbox" data-preset-path="ctaScripts.${ctaIndex}.useDefaultUrl" ${cta.useDefaultUrl === false ? "" : "checked"}>
              </label>
            </div>

            <div class="cta-message-editor">
              <div class="capital-message-label">
                <strong>Messages</strong>
                <small>Une ligne = une bulle envoyee. Mets les etapes dans l'ordre naturel.</small>
              </div>

              <div class="cta-message-list">
                ${messages.map((message, messageIndex) => `
                  <article class="cta-message-card">
                    <div class="cta-message-card-head">
                      <strong>Message ${messageIndex + 1}</strong>
                      <button type="button" class="objection-card-icon danger" data-remove-cta-message="${ctaIndex}:${messageIndex}" aria-label="Supprimer">X</button>
                    </div>
                    <textarea class="compact-input cta-message-input" data-preset-path="ctaScripts.${ctaIndex}.messages.${messageIndex}.text">${escapeHtml(message.text || "")}</textarea>
                    <div class="cta-message-options">
                      <label class="capital-inline-toggle">
                        <span>Wait for reply</span>
                        <input type="checkbox" data-preset-path="ctaScripts.${ctaIndex}.messages.${messageIndex}.waitForReply" ${message.waitForReply ? "checked" : ""}>
                      </label>
                      <div class="field">
                        <label>Media source</label>
                        ${selectMarkup(`ctaScripts.${ctaIndex}.messages.${messageIndex}.mediaSource`, message.mediaSource || "none", mediaSources)}
                      </div>
                    </div>
                  </article>
                `).join("") || `<div class="empty-state">Aucun message dans ce CTA.</div>`}
              </div>

              <button type="button" class="cta-add-message" data-add-cta-message="${ctaIndex}">+ Add Message</button>
            </div>
          </div>
        </article>
          `;
        }).join("") || `<div class="empty-state">Aucun CTA dans ce cycle.</div>`}
      </div>

      <button type="button" class="objection-add-button" id="add-cta">+ Add CTA</button>
    </section>
  `;

  return `
    <section class="capital-config-panel">
      <div class="capital-section">
        <h3>Call-To-Action</h3>
        <p>Configure les messages que l'IA utilise quand la phase active doit convertir.</p>
        <div class="capital-info-card">
          <span class="shortcut-icon">L</span>
          <span>
            <strong>Default URL</strong>
            <small>${escapeHtml(activeUrl)}</small>
          </span>
          <button type="button" class="icon-action" data-open-editor-tab="urls" aria-label="Ouvrir URLs">&gt;</button>
        </div>
      </div>

      <div class="capital-section">
        <h3>Custom CTA Messages</h3>
        <p>Add multiple CTA messages. The selected URL can be appended when the CTA is active.</p>
        <div class="capital-card-list">
          ${scripts.map((cta, ctaIndex) => `
            <article class="capital-card">
              <div class="capital-card-head">
                <span class="drag-handle" aria-hidden="true">::</span>
                <input class="capital-title-input" data-preset-path="ctaScripts.${ctaIndex}.title" value="${escapeHtml(cta.title || `CTA ${ctaIndex + 1}`)}" aria-label="CTA title">
                <button type="button" class="icon-action danger" data-remove-cta="${ctaIndex}" aria-label="Supprimer">DEL</button>
              </div>
              <div class="capital-card-grid three">
                <div class="compact-field">
                  <label>Cycle</label>
                  ${selectMarkup(`ctaScripts.${ctaIndex}.cycle`, Number(cta.cycle || 1), cycleOptions.length ? cycleOptions : [{ value: 1, label: "Cycle 1" }])}
                </div>
                <label class="capital-inline-toggle">
                  <span>Active</span>
                  <input type="checkbox" data-preset-path="ctaScripts.${ctaIndex}.enabled" ${cta.enabled === false ? "" : "checked"}>
                </label>
                <label class="capital-inline-toggle">
                  <span>Use default URL</span>
                  <input type="checkbox" data-preset-path="ctaScripts.${ctaIndex}.useDefaultUrl" ${cta.useDefaultUrl === false ? "" : "checked"}>
                </label>
              </div>
              <div class="capital-message-label">
                <strong>Messages</strong>
                <small>Each row is a possible step. Wait for reply stops the sequence before sending the next CTA idea.</small>
              </div>
              <div class="capital-message-list">
                ${(Array.isArray(cta.messages) ? cta.messages : []).map((message, messageIndex) => `
                  <div class="capital-message-row cta">
                    <textarea class="compact-input capital-message-input" data-preset-path="ctaScripts.${ctaIndex}.messages.${messageIndex}.text">${escapeHtml(message.text || "")}</textarea>
                    <label class="capital-inline-toggle mini">
                      <span>Wait</span>
                      <input type="checkbox" data-preset-path="ctaScripts.${ctaIndex}.messages.${messageIndex}.waitForReply" ${message.waitForReply ? "checked" : ""}>
                    </label>
                    <div class="compact-field">
                      <label>Media</label>
                      ${selectMarkup(`ctaScripts.${ctaIndex}.messages.${messageIndex}.mediaSource`, message.mediaSource || "none", mediaSources)}
                    </div>
                    <button type="button" class="icon-action danger" data-remove-cta-message="${ctaIndex}:${messageIndex}" aria-label="Supprimer">DEL</button>
                  </div>
                `).join("") || `<div class="empty-state">Aucun message dans ce CTA.</div>`}
              </div>
              <button type="button" class="button secondary capital-add-message" data-add-cta-message="${ctaIndex}">+ Add Message</button>
            </article>
          `).join("") || `<div class="empty-state">Aucun CTA configure.</div>`}
        </div>
        <button type="button" class="button secondary capital-add-card" id="add-cta">+ Add CTA</button>
      </div>
    </section>
  `;
}

// Options for the snap model-setup <select> in the URL config.
function snapModelSelectOptions() {
  const setups = state.config?.snapchat?.modelSetups || [];
  return [
    { value: "", label: setups.length ? "— Choisir un model —" : "Aucun model (voir Settings Snapchat)" },
    ...setups.map((m) => ({ value: m.id, label: m.name || m.model || m.id })),
  ];
}

// Client-side mirror of server resolveSnapHandle(): preview the handle a snap
// model would push (RECEIVING > OVERFLOW > any pool account), applying the template.
function resolveSnapHandlePreview(snapModelId) {
  const snap = state.config?.snapchat;
  if (!snap) return "";
  const setup = (snap.modelSetups || []).find((m) => m.id === snapModelId);
  const pool = setup?.accountPool || [];
  if (!pool.length) return "";
  const receiving = new Set(snap.accounts?.receiving || []);
  const overflow = new Set(snap.accounts?.overflow || []);
  const handle = pool.find((u) => receiving.has(u)) || pool.find((u) => overflow.has(u)) || pool[0] || "";
  if (!handle) return "";
  const template = String(snap.handleUrlTemplate || "{username}");
  return template.includes("{username}") ? template.replace(/\{username\}/g, handle) : handle;
}

function renderUrls(preset) {
  const items = Array.isArray(preset.urls?.items) ? preset.urls.items : [];
  return `
    <section class="objections-screen">
      <div class="objections-title">
        <h3>URLs</h3>
        <p>Configure CTA URLs and platforms</p>
      </div>

      <div class="band-heading">
        <div><h3>Choose Randomly</h3><p>Pick a random URL from the list when sending CTA</p></div>
        ${toggle("", "urls.chooseRandomly", preset.urls.chooseRandomly)}
      </div>

      <div class="objection-card-list">
        ${items.map((item, index) => {
          const urlKey = String(index);
          const expanded = state.expandedUrlKey === urlKey;
          return `
            <article class="objection-card ${expanded ? "expanded" : ""}">
              <div class="objection-card-head">
                <div class="objection-title-line">
                  <strong>URL ${index + 1}</strong>
                </div>
                <button type="button" class="objection-card-icon danger" data-remove-url="${index}" aria-label="Supprimer">X</button>
                <button type="button" class="objection-card-icon" data-toggle-url-details="${urlKey}" aria-label="Afficher les details">${expanded ? "^" : "v"}</button>
              </div>
              <div class="objection-details">
                <div class="form-grid">
                  <div class="field">
                    <label>Platform</label>
                    ${selectMarkup(`urls.items.${index}.platform`, item.platform, platformOptions)}
                  </div>
                  ${field({ label: "Nom affiche", path: `urls.items.${index}.displayLabel`, value: item.displayLabel || item.platform || "" })}
                  ${item.platform === "snap"
                    ? `
                    <div class="field">
                      <label>Model setup Snapchat</label>
                      ${selectMarkup(`urls.items.${index}.snapModel`, item.snapModel || "", snapModelSelectOptions())}
                    </div>
                    <div class="field full">
                      <label>Compte Snap (auto)</label>
                      <input type="text" value="${escapeHtml(resolveSnapHandlePreview(item.snapModel) || "— aucun compte disponible —")}" readonly>
                      <p class="field-help">Username Snapchat pousse aux inconnus, resolu en direct depuis le pool RECEIVING du model au moment de l'envoi. Configure les models dans Settings Snapchat.</p>
                    </div>
                  `
                    : field({ label: "URL", path: `urls.items.${index}.url`, value: item.url, full: true, help: "Le lien est envoye exactement tel quel, sans aucune modification." })}
                </div>
                <div class="url-card-toggles">
                  ${toggle("Active", `urls.items.${index}.enabled`, item.enabled)}
                </div>
              </div>
            </article>
          `;
        }).join("") || `<div class="empty-state">Aucune URL configuree.</div>`}
      </div>

      <button type="button" class="objection-add-button" id="add-url">+ Add URL</button>
    </section>
  `;
}

function renderAdvancedObjections(preset) {
  return `
    <section class="objections-screen">
      <div class="objections-title">
        <h3>Objections</h3>
        <p>Automated responses to common objections</p>
      </div>

      <div class="objection-card-list">
        ${preset.objections.map((item, index) => {
          const objectionKey = String(index);
          const expanded = state.expandedObjectionKey === objectionKey;
          return `
            <article class="objection-card ${expanded ? "expanded" : ""}">
              <div class="objection-card-head">
                <div class="objection-title-line">
                  <strong>${escapeHtml(item.trigger || `Objection ${index + 1}`)}</strong>
                </div>
                <button type="button" class="objection-card-icon danger" data-remove-objection="${index}" aria-label="Supprimer">X</button>
                <button type="button" class="objection-card-icon" data-toggle-objection-details="${objectionKey}" aria-label="Afficher les details">${expanded ? "^" : "v"}</button>
              </div>
              <div class="objection-details">
                <div class="form-grid">
                  ${field({ label: "Objection", path: `objections.${index}.trigger`, value: item.trigger })}
                  ${field({ label: "Reponse / spintax", path: `objections.${index}.response`, value: item.response, type: "textarea", full: true, rows: 4 })}
                  ${field({ label: "Contexte CTA", path: `objections.${index}.ctaTiming`, value: item.ctaTiming || "both", type: "select", options: objectionCtaTimingOptions })}
                  ${field({ label: "Source media", path: `objections.${index}.mediaSource`, value: item.mediaSource || "none", type: "select", options: mediaSources })}
                  <div class="objection-stop-row">
                    ${toggle("Envoyer le CTA avec cette reponse", `objections.${index}.sendCta`, item.sendCta)}
                    <p>Ajoute le CTA (lien, pseudo ou identifiant, tel qu'il est configure dans URLs) a la reponse a cette objection, une seule fois s'il n'a pas deja ete envoye.</p>
                  </div>
                  <div class="objection-stop-row">
                    ${toggle("Arreter apres cette objection", `objections.${index}.stopAfterResponse`, item.stopAfterResponse)}
                    <p>Envoie cette reponse une fois, puis ne relance plus cette conversation.</p>
                  </div>
                  ${toggle("Active", `objections.${index}.enabled`, item.enabled)}
                </div>
              </div>
            </article>
          `;
        }).join("") || `<div class="empty-state">Aucune objection configuree.</div>`}
      </div>

      <button type="button" class="objection-add-button" id="add-objection">+ Add Objection</button>
    </section>
  `;

  return `
    <section class="settings-band">
      <div class="band-heading"><div><h3>Objections</h3><p>Le moteur détecte le sens puis reformule la réponse avec le style du personnage.</p></div></div>
      <div class="config-block-list">
        ${preset.objections.map((item, index) => `
          <article class="objection-row">
            <div class="compact-field"><label>Objection</label><input class="compact-input" data-preset-path="objections.${index}.trigger" value="${escapeHtml(item.trigger)}"></div>
            <div class="compact-field"><label>Réponse / spintax</label><textarea class="compact-input compact-area" data-preset-path="objections.${index}.response">${escapeHtml(item.response)}</textarea></div>
            <div class="compact-field"><label>Source média</label>${selectMarkup(`objections.${index}.mediaSource`, item.mediaSource || "none", mediaSources)}</div>
            ${toggle("Active", `objections.${index}.enabled`, item.enabled)}
            <button type="button" class="remove-row" data-remove-objection="${index}" aria-label="Supprimer">×</button>
          </article>
        `).join("")}
      </div>
      <button type="button" class="button secondary add-row" id="add-objection">Ajouter une objection</button>
    </section>
  `;
}

function renderSprinkles(preset) {
  return `
    <section class="settings-band">
      <div class="band-heading"><div><h3>Sprinkles</h3><p>Petites interruptions contextuelles pour rendre le rythme moins mécanique.</p></div></div>
      <div class="config-block-list">
        ${preset.sprinkles.map((item, index) => `
          <article class="sequence-row">
            <div class="compact-field"><label>Nom</label><input class="compact-input" data-preset-path="sprinkles.${index}.name" value="${escapeHtml(item.name)}"></div>
            <div class="compact-field"><label>Messages</label><textarea class="compact-input compact-area" data-preset-path="sprinkles.${index}.messages" data-list="lines">${escapeHtml(item.messages.join("\n"))}</textarea></div>
            <div class="compact-field"><label>Source média</label>${selectMarkup(`sprinkles.${index}.mediaSource`, item.mediaSource, mediaSources)}</div>
            ${toggle("Actif", `sprinkles.${index}.enabled`, item.enabled)}
            <button type="button" class="remove-row" data-remove-sprinkle="${index}" aria-label="Supprimer">×</button>
          </article>
        `).join("")}
      </div>
      <button type="button" class="button secondary add-row" id="add-sprinkle">Ajouter un sprinkle</button>
    </section>
  `;
}

function renderSprinklesCapital(preset) {
  const items = Array.isArray(preset.sprinkles) ? preset.sprinkles : [];
  return `
    <section class="objections-screen">
      <div class="objections-title">
        <h3>Sprinkles</h3>
        <p>Small contextual messages that make the conversation feel less mechanical</p>
      </div>

      <div class="objection-card-list">
        ${items.map((item, index) => {
          const sprinkleKey = String(index);
          const expanded = state.expandedSprinkleKey === sprinkleKey;
          const messages = Array.isArray(item.messages) ? item.messages : [];
          const preview = messages.find((message) => String(message || "").trim())
            || "Aucun message configure";
          return `
            <article class="objection-card ${expanded ? "expanded" : ""}">
              <div class="objection-card-head">
                <div class="objection-title-line">
                  <strong>${escapeHtml(item.name || `Sprinkle ${index + 1}`)}</strong>
                  <small>${escapeHtml(preview)}</small>
                </div>
                <span class="cta-pill ${item.enabled === false ? "off" : ""}">${item.enabled === false ? "Off" : "Active"}</span>
                <button type="button" class="objection-card-icon danger" data-remove-sprinkle="${index}" aria-label="Supprimer">X</button>
                <button type="button" class="objection-card-icon" data-toggle-sprinkle-details="${sprinkleKey}" aria-label="Afficher les details">${expanded ? "^" : "v"}</button>
              </div>
              <div class="objection-details">
                <div class="form-grid">
                  ${field({ label: "Nom", path: `sprinkles.${index}.name`, value: item.name || `Sprinkle ${index + 1}` })}
                  ${field({
                    label: "Messages",
                    path: `sprinkles.${index}.messages`,
                    value: messages,
                    type: "textarea",
                    full: true,
                    rows: 5,
                    list: "lines",
                    help: "Une ligne = une bulle possible. L'IA choisit ou reformule selon le contexte.",
                  })}
                  ${field({ label: "Source media", path: `sprinkles.${index}.mediaSource`, value: item.mediaSource || "none", type: "select", options: mediaSources })}
                  ${toggle("Active", `sprinkles.${index}.enabled`, item.enabled)}
                </div>
              </div>
            </article>
          `;
        }).join("") || `<div class="empty-state">Aucun sprinkle configure.</div>`}
      </div>

      <button type="button" class="objection-add-button" id="add-sprinkle">+ Add Sprinkle</button>
    </section>
  `;
}

function renderFollowups(preset) {
  return `
    <section class="settings-band">
      <div class="band-heading">
        <div><h3>Relances automatiques</h3><p>Déclenchées quand le dernier message vient du bot et que le délai est dépassé.</p></div>
        ${toggle("Activer", "followups.enabled", preset.followups.enabled)}
      </div>
      <div class="form-grid">
        ${field({ label: "Délai (heures)", path: "followups.delayHours", value: preset.followups.delayHours, type: "number", min: 1, max: 720 })}
        ${field({ label: "Nombre maximum", path: "followups.maxCount", value: preset.followups.maxCount, type: "number", min: 1, max: 20 })}
      </div>
      <div class="config-block-list">
        ${preset.followups.items.map((item, index) => `
          <article class="sequence-row">
            <div class="compact-field"><label>Titre</label><input class="compact-input" data-preset-path="followups.items.${index}.title" value="${escapeHtml(item.title)}"></div>
            <div class="compact-field"><label>Messages / spintax</label><textarea class="compact-input compact-area" data-preset-path="followups.items.${index}.messages" data-list="lines">${escapeHtml(item.messages.join("\n"))}</textarea></div>
            <div class="compact-field"><label>Source média</label>${selectMarkup(`followups.items.${index}.mediaSource`, item.mediaSource, mediaSources)}</div>
            ${toggle("Actif", `followups.items.${index}.enabled`, item.enabled)}
            <button type="button" class="remove-row" data-remove-followup="${index}" aria-label="Supprimer">×</button>
          </article>
        `).join("")}
      </div>
      <button type="button" class="button secondary add-row" id="add-followup">Ajouter une relance</button>
    </section>
  `;
}

function renderFollowupsCapital(preset) {
  const followups = preset.followups || {};
  const items = Array.isArray(followups.items) ? followups.items : [];
  return `
    <section class="objections-screen">
      <div class="objections-title">
        <h3>Follow-ups</h3>
        <p>Automatic messages sent when the user leaves the conversation on read</p>
      </div>

      <div class="followup-control-card">
        <label class="capital-inline-toggle">
          <span>Enable follow-ups</span>
          <input type="checkbox" data-preset-path="followups.enabled" ${followups.enabled ? "checked" : ""}>
        </label>
        ${field({ label: "Delay (hours)", path: "followups.delayHours", value: followups.delayHours, type: "number", min: 1, max: 720 })}
        ${field({ label: "Maximum follow-ups", path: "followups.maxCount", value: followups.maxCount, type: "number", min: 1, max: 20 })}
      </div>

      <div class="objection-card-list">
        ${items.map((item, index) => {
          const followupKey = String(index);
          const expanded = state.expandedFollowupKey === followupKey;
          const messages = Array.isArray(item.messages) ? item.messages : [];
          const preview = messages.find((message) => String(message || "").trim())
            || "Aucun message configure";
          return `
            <article class="objection-card ${expanded ? "expanded" : ""}">
              <div class="objection-card-head">
                <div class="objection-title-line">
                  <strong>${escapeHtml(item.title || `Follow-up ${index + 1}`)}</strong>
                  <small>${escapeHtml(preview)}</small>
                </div>
                <span class="cta-pill ${item.enabled === false ? "off" : ""}">${item.enabled === false ? "Off" : "Active"}</span>
                <button type="button" class="objection-card-icon danger" data-remove-followup="${index}" aria-label="Supprimer">X</button>
                <button type="button" class="objection-card-icon" data-toggle-followup-details="${followupKey}" aria-label="Afficher les details">${expanded ? "^" : "v"}</button>
              </div>
              <div class="objection-details">
                <div class="form-grid">
                  ${field({ label: "Title", path: `followups.items.${index}.title`, value: item.title || `Follow-up ${index + 1}` })}
                  ${field({
                    label: "Messages",
                    path: `followups.items.${index}.messages`,
                    value: messages,
                    type: "textarea",
                    full: true,
                    rows: 5,
                    list: "lines",
                    help: "Une ligne = une bulle envoyee. Le bot peut les envoyer dans l'ordre.",
                  })}
                  ${field({ label: "Media source", path: `followups.items.${index}.mediaSource`, value: item.mediaSource || "none", type: "select", options: mediaSources })}
                  ${toggle("Active", `followups.items.${index}.enabled`, item.enabled)}
                </div>
              </div>
            </article>
          `;
        }).join("") || `<div class="empty-state">Aucun follow-up configure.</div>`}
      </div>

      <button type="button" class="objection-add-button" id="add-followup">+ Add Follow-up</button>
    </section>
  `;
}

function renderFinishers(preset) {
  return `
    <section class="settings-band">
      <div class="band-heading"><div><h3>Finisher</h3><p>Messages finaux déclenchés à la limite d'échanges ou après les cycles.</p></div></div>
      <div class="toggle-grid">
        ${toggle("À la limite d'échanges", "finishers.onMessageLimit", preset.finishers.onMessageLimit)}
        ${toggle("Après tous les cycles", "finishers.afterAllCycles", preset.finishers.afterAllCycles)}
      </div>
      <div class="config-block-list">
        ${preset.finishers.items.map((item, index) => `
          <article class="sequence-row">
            <div class="compact-field"><label>Titre</label><input class="compact-input" data-preset-path="finishers.items.${index}.title" value="${escapeHtml(item.title)}"></div>
            <div class="compact-field"><label>Messages / spintax</label><textarea class="compact-input compact-area" data-preset-path="finishers.items.${index}.messages" data-list="lines">${escapeHtml(item.messages.join("\n"))}</textarea></div>
            <div class="compact-field"><label>Source média</label>${selectMarkup(`finishers.items.${index}.mediaSource`, item.mediaSource, mediaSources)}</div>
            ${toggle("URL par défaut", `finishers.items.${index}.useDefaultUrl`, item.useDefaultUrl)}
            ${toggle("Actif", `finishers.items.${index}.enabled`, item.enabled)}
            <button type="button" class="remove-row" data-remove-finisher="${index}" aria-label="Supprimer">×</button>
          </article>
        `).join("")}
      </div>
      <button type="button" class="button secondary add-row" id="add-finisher">Ajouter un finisher</button>
    </section>
  `;
}

function renderFinishersCapital(preset) {
  return `
    <section class="finisher-panel">
      <div class="finisher-section">
        <h3>Trigger Conditions</h3>
        <p>Choose when the finisher message should be sent</p>
        <div class="finisher-trigger-list">
          <label class="finisher-trigger-card">
            <input type="checkbox" data-preset-path="finishers.onMessageLimit" ${preset.finishers.onMessageLimit ? "checked" : ""}>
            <span>
              <strong>On Exchange Limit</strong>
              <small>Send finisher when the conversation hits the configured exchange limit. One exchange = a user message group answered by one AI generation.</small>
            </span>
          </label>
          <label class="finisher-trigger-card">
            <input type="checkbox" data-preset-path="finishers.afterAllCycles" ${preset.finishers.afterAllCycles ? "checked" : ""}>
            <span>
              <strong>After All Cycles Complete</strong>
              <small>Send finisher after the configured cycles and CTA window are complete</small>
            </span>
          </label>
        </div>
      </div>

      <div class="finisher-section">
        <h3>Custom Finisher Messages</h3>
        <p>Add alternative finisher messages. One will be picked at random when the conversation ends.</p>
        <div class="finisher-list">
          ${preset.finishers.items.map((item, index) => {
            const finisherKey = String(index);
            const collapsed = state.collapsedFinisherKeys.has(finisherKey);
            return `
            <article class="finisher-card ${collapsed ? "collapsed" : ""}">
              <div class="finisher-card-head">
                <input class="finisher-title-input" data-preset-path="finishers.items.${index}.title" value="${escapeHtml(item.title)}" aria-label="Finisher title">
                <div class="finisher-card-actions">
                  <button type="button" class="icon-action danger" data-remove-finisher="${index}" aria-label="Remove finisher">Delete</button>
                  <button type="button" class="icon-action finisher-chevron" data-toggle-finisher-details="${finisherKey}" aria-label="Toggle finisher">${collapsed ? "^" : "v"}</button>
                </div>
              </div>
              <div class="finisher-card-body">
                <label class="finisher-url-toggle">
                  <span>
                    <strong>Use default URL:</strong>
                    <small>When enabled, the preset's CTA URL will be appended as the last message</small>
                  </span>
                  <input type="checkbox" data-preset-path="finishers.items.${index}.useDefaultUrl" ${item.useDefaultUrl ? "checked" : ""}>
                </label>
                <div class="finisher-card-grid">
                  <div class="compact-field">
                    <label>Media source</label>
                    ${selectMarkup(`finishers.items.${index}.mediaSource`, item.mediaSource, mediaSources)}
                  </div>
                  <label class="finisher-enabled-row">
                    <span>Finisher active</span>
                    <input type="checkbox" data-preset-path="finishers.items.${index}.enabled" ${item.enabled ? "checked" : ""}>
                  </label>
                </div>
                <div class="finisher-messages-label">
                  <strong>Messages:</strong>
                  <small>Add multiple messages. They'll be sent in sequence as individual bubbles. The URL will be appended as the final bubble.</small>
                </div>
                <div class="finisher-message-list">
                  ${(Array.isArray(item.messages) ? item.messages : [""]).map((message, messageIndex) => `
                    <div class="finisher-message-row">
                      <textarea class="compact-input finisher-message-input" data-preset-path="finishers.items.${index}.messages.${messageIndex}">${escapeHtml(message)}</textarea>
                      <button type="button" class="icon-action danger" data-remove-finisher-message="${index}:${messageIndex}" aria-label="Remove message">Delete</button>
                    </div>
                  `).join("")}
                </div>
                <button type="button" class="button ghost finisher-add-message" data-add-finisher-message="${index}">+ Add Message</button>
              </div>
            </article>
          `;
          }).join("")}
        </div>
        <button type="button" class="button secondary finisher-add-card" id="add-finisher">+ Add Finisher</button>
      </div>
    </section>
  `;
}

function renderFinishersCards(preset) {
  const finishers = preset.finishers || {};
  const items = Array.isArray(finishers.items) ? finishers.items : [];
  return `
    <section class="objections-screen">
      <div class="objections-title">
        <h3>Finisher</h3>
        <p>Final messages sent when the conversation reaches an exchange limit or another end condition</p>
      </div>

      <div class="followup-control-card">
        ${presetToggleButton(
          "Limite d'échanges",
          "finishers.onMessageLimit",
          Boolean(finishers.onMessageLimit),
        )}
        ${field({
          label: "Nombre d'échanges",
          path: "finishers.messageLimit",
          value: Number(finishers.messageLimit || 100),
          type: "number",
          min: 1,
          max: 1000,
          help: "1 echange = un ou plusieurs messages utilisateur suivis d'une reponse IA. Plusieurs bulles IA comptent toujours pour 1 seul echange.",
        })}
        ${presetToggleButton(
          "Apres tous les cycles",
          "finishers.afterAllCycles",
          Boolean(finishers.afterAllCycles),
        )}
      </div>

      <div class="objection-card-list">
        ${items.map((item, index) => {
          const finisherKey = String(index);
          const expanded = state.expandedFinisherKey === finisherKey;
          const messages = Array.isArray(item.messages) ? item.messages : [];
          const preview = messages.find((message) => String(message || "").trim())
            || "Aucun message configure";
          return `
            <article class="objection-card ${expanded ? "expanded" : ""}">
              <div class="objection-card-head">
                <div class="objection-title-line">
                  <strong>${escapeHtml(item.title || `Finisher ${index + 1}`)}</strong>
                  <small>${escapeHtml(preview)}</small>
                </div>
                <span class="cta-pill ${item.enabled === false ? "off" : ""}">${item.enabled === false ? "Off" : "Active"}</span>
                <button type="button" class="objection-card-icon danger" data-remove-finisher="${index}" aria-label="Supprimer">X</button>
                <button type="button" class="objection-card-icon" data-toggle-finisher-details="${finisherKey}" aria-label="Afficher les details">${expanded ? "^" : "v"}</button>
              </div>
              <div class="objection-details">
                <div class="form-grid">
                  ${field({ label: "Title", path: `finishers.items.${index}.title`, value: item.title || `Finisher ${index + 1}` })}
                  ${field({
                    label: "Messages",
                    path: `finishers.items.${index}.messages`,
                    value: messages,
                    type: "textarea",
                    full: true,
                    rows: 5,
                    list: "lines",
                    help: "Une ligne = une bulle envoyee. Le lien peut etre ajoute apres ces messages.",
                  })}
                  ${field({ label: "Media source", path: `finishers.items.${index}.mediaSource`, value: item.mediaSource || "none", type: "select", options: mediaSources })}
                  ${toggle("Use default URL", `finishers.items.${index}.useDefaultUrl`, item.useDefaultUrl)}
                  ${toggle("Active", `finishers.items.${index}.enabled`, item.enabled)}
                </div>
              </div>
            </article>
          `;
        }).join("") || `<div class="empty-state">Aucun finisher configure.</div>`}
      </div>

      <button type="button" class="objection-add-button" id="add-finisher">+ Add Finisher</button>
    </section>
  `;
}

function renderIgnoreConditions(preset) {
  return `
    <section class="settings-band">
      <div class="band-heading"><div><h3>Conditions d’ignorance</h3><p>Une condition correspondante ignore silencieusement la conversation avant génération.</p></div></div>
      <div class="form-grid">
        <div>${toggle("Ignorer les anciennes conversations", "ignoreConditions.avoidOlderEnabled", preset.ignoreConditions.avoidOlderEnabled)}</div>
        ${field({ label: "Créées avant", path: "ignoreConditions.avoidOlderThan", value: preset.ignoreConditions.avoidOlderThan, type: "datetime-local" })}
      </div>
    </section>
    <section class="settings-band">
      <div class="band-heading"><div><h3>Conditions comportementales</h3><p>Décris le comportement à classifier en langage naturel.</p></div></div>
      <div class="config-block-list">
        ${preset.ignoreConditions.behavioral.map((item, index) => `
          <article class="condition-row">
            <div class="compact-field"><label>Condition</label><input class="compact-input" data-preset-path="ignoreConditions.behavioral.${index}.description" value="${escapeHtml(item.description)}"></div>
            ${toggle("Active", `ignoreConditions.behavioral.${index}.enabled`, item.enabled)}
            <button type="button" class="remove-row" data-remove-condition="${index}" aria-label="Supprimer">×</button>
          </article>
        `).join("")}
      </div>
      <button type="button" class="button secondary add-row" id="add-condition">Ajouter une condition</button>
    </section>
    <section class="settings-band">
      <div class="band-heading"><div><h3>Listes de pseudos et UUID</h3><p>Listes réutilisables activées séparément pour ce preset.</p></div></div>
      <div class="config-block-list">
        ${preset.ignoreConditions.lists.map((item, index) => `
          <article class="sequence-row">
            <div class="compact-field"><label>Nom</label><input class="compact-input" data-preset-path="ignoreConditions.lists.${index}.name" value="${escapeHtml(item.name)}"></div>
            <div class="compact-field"><label>Entrées</label><textarea class="compact-input compact-area" data-preset-path="ignoreConditions.lists.${index}.entries" data-list="lines">${escapeHtml(item.entries.join("\n"))}</textarea></div>
            ${toggle("Active", `ignoreConditions.lists.${index}.enabled`, item.enabled)}
            <button type="button" class="remove-row" data-remove-ignore-list="${index}" aria-label="Supprimer">×</button>
          </article>
        `).join("")}
      </div>
      <button type="button" class="button secondary add-row" id="add-ignore-list">Nouvelle liste</button>
    </section>
  `;
}

function renderStrategy(preset) {
  return `
    <section class="settings-band">
      <div class="band-heading">
        <div>
          <h3>Objectif de conversation</h3>
          <p>Le LLM rédige; ces règles déterminent quand et pourquoi proposer le lien.</p>
        </div>
      </div>
      <div class="form-grid">
        ${field({ label: "Objectif principal", path: "strategy.objective", value: preset.strategy.objective, type: "textarea", full: true, rows: 4 })}
        ${field({ label: "Lien à proposer", path: "strategy.ctaLink", value: preset.strategy.ctaLink, type: "url", help: "Utilisable avec la variable {{link}} dans les séquences." })}
        ${field({ label: "Après combien d’échanges", path: "strategy.ctaAfterExchanges", value: preset.strategy.ctaAfterExchanges, type: "number", min: 1, max: 100 })}
        ${field({ label: "Tentatives maximum", path: "strategy.ctaMaxAttempts", value: preset.strategy.ctaMaxAttempts, type: "number", min: 1, max: 10 })}
        ${field({ label: "Instruction CTA", path: "strategy.ctaInstruction", value: preset.strategy.ctaInstruction, type: "textarea", full: true, rows: 4 })}
        ${field({ label: "Signaux de conversion", path: "strategy.conversionSignals", value: preset.strategy.conversionSignals, type: "textarea", rows: 3 })}
        ${field({ label: "Signaux d’arrêt", path: "strategy.stopSignals", value: preset.strategy.stopSignals, type: "textarea", rows: 3 })}
      </div>
    </section>
    <section class="settings-band">
      <div class="band-heading">
        <div>
          <h3>Comportement automatique</h3>
          <p>Délais, mémoire et protections appliqués avant la génération.</p>
        </div>
      </div>
      <div class="form-grid three">
        ${field({ label: "Délai minimum (secondes)", path: "behavior.minDelaySeconds", value: preset.behavior.minDelaySeconds, type: "number", min: 0, max: 300 })}
        ${field({ label: "Délai maximum (secondes)", path: "behavior.maxDelaySeconds", value: preset.behavior.maxDelaySeconds, type: "number", min: 0, max: 600 })}
        ${field({ label: "Messages récents exacts", path: "behavior.recentMessages", value: preset.behavior.recentMessages, type: "number", min: 5, max: 100 })}
      </div>
      <div class="toggle-grid">
        ${toggle("Résumé de l’historique", "behavior.useConversationSummary", preset.behavior.useConversationSummary)}
        ${toggle("Adapter à la localisation", "behavior.adaptToLocation", preset.behavior.adaptToLocation)}
        ${toggle("Non-lus uniquement", "behavior.processUnreadOnly", preset.behavior.processUnreadOnly)}
        ${toggle("Filtre anti-répétition", "behavior.antiRepeat", preset.behavior.antiRepeat)}
      </div>
    </section>
  `;
}

function renderPhaseRows(preset) {
  return preset.phases.map((phase, index) => `
    <div class="repeater-row">
      <div class="compact-field">
        <label>Phase</label>
        <input class="compact-input" data-preset-path="phases.${index}.name" value="${escapeHtml(phase.name)}">
      </div>
      <div class="compact-field">
        <label>Objectif</label>
        <input class="compact-input" data-preset-path="phases.${index}.objective" value="${escapeHtml(phase.objective)}">
      </div>
      <div class="compact-field">
        <label>Échanges</label>
        <input class="compact-input" type="number" min="1" max="100" data-preset-path="phases.${index}.exchanges" value="${escapeHtml(phase.exchanges)}">
      </div>
      <div class="compact-field">
        <label>Média %</label>
        <input class="compact-input" type="number" min="0" max="100" data-preset-path="phases.${index}.mediaProbability" value="${escapeHtml(phase.mediaProbability)}">
      </div>
      <button type="button" class="remove-row" data-remove-phase="${index}" aria-label="Supprimer la phase">×</button>
    </div>
  `).join("");
}

function renderObjectionRows(preset) {
  return preset.objections.map((objection, index) => `
    <div class="repeater-row objection">
      <div class="compact-field">
        <label>Déclencheur</label>
        <input class="compact-input" data-preset-path="objections.${index}.trigger" value="${escapeHtml(objection.trigger)}">
      </div>
      <div class="compact-field">
        <label>Réponse attendue</label>
        <input class="compact-input" data-preset-path="objections.${index}.response" value="${escapeHtml(objection.response)}">
      </div>
      <label class="toggle-field">
        <span>Active</span>
        <input type="checkbox" data-preset-path="objections.${index}.enabled" ${objection.enabled ? "checked" : ""}>
      </label>
      <button type="button" class="remove-row" data-remove-objection="${index}" aria-label="Supprimer l'objection">×</button>
    </div>
  `).join("");
}

function renderFlow(preset) {
  return `
    <section class="settings-band">
      <div class="band-heading">
        <div>
          <h3>Phases de conversation</h3>
          <p>Le moteur avance dans l’ordre et injecte l’objectif de la phase active.</p>
        </div>
      </div>
      <div class="repeater-list">${renderPhaseRows(preset)}</div>
      <button type="button" id="add-phase" class="button secondary add-row">Ajouter une phase</button>
    </section>
    <section class="settings-band">
      <div class="band-heading">
        <div>
          <h3>Séquences</h3>
          <p>Une ligne correspond à une bulle. La variable {{link}} insère le lien du preset.</p>
        </div>
      </div>
      <div class="sequence-grid">
        ${field({ label: "Ouverture", path: "sequences.openers", value: preset.sequences.openers, type: "textarea", rows: 5, list: "lines" })}
        ${field({ label: "Call-to-action", path: "sequences.cta", value: preset.sequences.cta, type: "textarea", rows: 5, list: "lines" })}
        ${field({ label: "Relances", path: "sequences.followups", value: preset.sequences.followups, type: "textarea", rows: 5, list: "lines" })}
        ${field({ label: "Fin de conversation", path: "sequences.finishers", value: preset.sequences.finishers, type: "textarea", rows: 5, list: "lines" })}
      </div>
    </section>
    <section class="settings-band">
      <div class="band-heading">
        <div>
          <h3>Objections</h3>
          <p>Détection sémantique puis instruction de réponse adaptée.</p>
        </div>
      </div>
      <div class="repeater-list">${renderObjectionRows(preset)}</div>
      <button type="button" id="add-objection" class="button secondary add-row">Ajouter une objection</button>
    </section>
  `;
}

function renderMedia(preset) {
  return `
    <section class="settings-band">
      <div class="band-heading">
        <div>
          <h3>Capacités médias</h3>
          <p>Détermine les formats que le moteur peut sélectionner.</p>
        </div>
      </div>
      <div class="toggle-grid">
        ${toggle("Photos", "behavior.imageEnabled", preset.behavior.imageEnabled)}
        ${toggle("Vidéos", "behavior.videoEnabled", preset.behavior.videoEnabled)}
        ${toggle("Audio", "behavior.audioEnabled", preset.behavior.audioEnabled)}
        ${toggle("Envoyer sur demande", "media.sendOnRequest", preset.media.sendOnRequest)}
        ${toggle("Sélection aléatoire", "media.randomize", preset.media.randomize)}
        ${toggle("Éviter les doublons", "media.avoidReuse", preset.media.avoidReuse)}
      </div>
    </section>
    <section class="settings-band">
      <div class="band-heading">
        <div>
          <h3>Bibliothèque du personnage</h3>
          <p>Le dossier reste local au serveur; seules les règles sont enregistrées ici.</p>
        </div>
      </div>
      <div class="form-grid">
        ${field({ label: "Dossier média", path: "media.folder", value: preset.media.folder })}
        ${field({ label: "Message avec la photo", path: "media.photoReply", value: preset.media.photoReply })}
        ${field({ label: "Catégories", path: "media.categories", value: preset.media.categories.join(", "), type: "textarea", full: true, rows: 3, list: "commas", help: "Séparées par des virgules." })}
      </div>
    </section>
  `;
}

function bindEditorControls() {
  bindConfigControls(elements.editorContent);
  bindSectionIo();

  for (const input of elements.editorContent.querySelectorAll("[data-preset-path]")) {
    const eventName = input.type === "range" ? "input" : "change";
    input.addEventListener(eventName, () => {
      setAtPath(currentPreset(), input.dataset.presetPath, inputValue(input));
      if (input.type === "range") {
        input.parentElement.querySelector(".range-value").textContent = input.value;
      }
      if (input.dataset.presetPath === "name") {
        elements.presetHeading.textContent = input.value;
        renderPresetList();
      }
      if (input.dataset.presetPath === "identity.name") renderPresetList();
      if (input.dataset.presetPath === "mainSettings.primaryLanguage") {
        const languageMap = {
          French: "fr",
          English: "en",
          Spanish: "auto",
          Italian: "auto",
          German: "auto",
          Auto: "auto",
        };
        currentPreset().identity.language = languageMap[input.value] || "auto";
      }
      if (input.dataset.presetPath === "identity.language") {
        const primaryMap = {
          fr: "French",
          en: "English",
          auto: "Auto",
        };
        currentPreset().mainSettings.primaryLanguage = primaryMap[input.value] || "Auto";
      }
      // A URL item switching to/from the "snap" platform (or picking a model)
      // changes which fields the card shows and the resolved-handle preview,
      // so re-render the editor to reflect it.
      if (/^urls\.items\.\d+\.(platform|snapModel)$/.test(input.dataset.presetPath)) {
        markDirty();
        renderEditor();
        return;
      }
      markDirty();
    });
  }
  for (const button of elements.editorContent.querySelectorAll("[data-preset-toggle-path]")) {
    button.addEventListener("click", () => {
      const path = button.dataset.presetTogglePath;
      setAtPath(currentPreset(), path, !valueAtPath(currentPreset(), path));
      markDirty();
      renderEditor();
    });
  }
  for (const button of elements.editorContent.querySelectorAll("[data-remove-phase]")) {
    button.addEventListener("click", () => {
      currentPreset().phases.splice(Number(button.dataset.removePhase), 1);
      markDirty();
      renderEditor();
    });
  }
  for (const button of elements.editorContent.querySelectorAll("[data-remove-objection]")) {
    button.addEventListener("click", () => {
      currentPreset().objections.splice(Number(button.dataset.removeObjection), 1);
      state.expandedObjectionKey = "";
      markDirty();
      renderEditor();
    });
  }
  for (const button of elements.editorContent.querySelectorAll("[data-toggle-objection-details]")) {
    button.addEventListener("click", () => {
      state.expandedObjectionKey = state.expandedObjectionKey === button.dataset.toggleObjectionDetails
        ? ""
        : button.dataset.toggleObjectionDetails;
      renderEditor();
    });
  }
  document.querySelector("#add-phase")?.addEventListener("click", () => {
    const index = currentPreset().phases.length + 1;
    currentPreset().phases.push({
      id: `phase-${index}`,
      name: `Phase ${index}`,
      objective: "",
      exchanges: 3,
      interestTarget: 50,
      mediaProbability: 0,
    });
    markDirty();
    renderEditor();
  });
  document.querySelector("#add-objection")?.addEventListener("click", () => {
    const index = currentPreset().objections.length + 1;
    currentPreset().objections.push({
      id: randomFourDigitId(currentPreset().objections.map((objection) => objection.id)),
      trigger: "",
      response: "",
      ctaTiming: "both",
      mediaSource: "none",
      sendCta: false,
      stopAfterResponse: false,
      enabled: true,
    });
    state.expandedObjectionKey = String(currentPreset().objections.length - 1);
    markDirty();
    renderEditor();
  });

  for (const button of elements.editorContent.querySelectorAll("[data-remove-opener]")) {
    button.addEventListener("click", () => {
      currentPreset().openers.items.splice(Number(button.dataset.removeOpener), 1);
      markDirty();
      renderEditor();
    });
  }
  for (const button of elements.editorContent.querySelectorAll("[data-remove-opener-message]")) {
    button.addEventListener("click", () => {
      const [openerIndex, messageIndex] = button.dataset.removeOpenerMessage
        .split(":")
        .map(Number);
      const messages = currentPreset().openers.items[openerIndex]?.messages;
      if (Array.isArray(messages)) {
        messages.splice(messageIndex, 1);
        if (!messages.length) messages.push("");
      }
      markDirty();
      renderEditor();
    });
  }
  for (const button of elements.editorContent.querySelectorAll("[data-toggle-opener-details]")) {
    button.addEventListener("click", () => {
      const key = button.dataset.toggleOpenerDetails;
      if (state.collapsedOpenerKeys.has(key)) {
        state.collapsedOpenerKeys.delete(key);
      } else {
        state.collapsedOpenerKeys.add(key);
      }
      renderEditor();
    });
  }
  for (const button of elements.editorContent.querySelectorAll("[data-add-opener-message]")) {
    button.addEventListener("click", () => {
      const opener = currentPreset().openers.items[Number(button.dataset.addOpenerMessage)];
      if (opener) {
        opener.messages = Array.isArray(opener.messages) ? opener.messages : [];
        opener.messages.push("");
      }
      markDirty();
      renderEditor();
    });
  }
  document.querySelector("#add-opener")?.addEventListener("click", () => {
    const index = currentPreset().openers.items.length + 1;
    currentPreset().openers.items.push({
      id: `opener-${index}`,
      title: `Opener ${index}`,
      messages: [""],
      mediaSource: "none",
      specificMediaIds: [],
      enabled: true,
    });
    markDirty();
    renderEditor();
  });

  for (const button of elements.editorContent.querySelectorAll("[data-cycle-index]")) {
    button.addEventListener("click", () => {
      state.activeCycleIndex = Number(button.dataset.cycleIndex);
      state.expandedPhaseKey = "";
      renderEditor();
    });
  }
  for (const button of elements.editorContent.querySelectorAll("[data-toggle-phase-details]")) {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      togglePhaseDetails(button.dataset.togglePhaseDetails);
    });
  }
  for (const details of elements.editorContent.querySelectorAll("[data-phase-details]")) {
    for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "focusin"]) {
      details.addEventListener(eventName, (event) => event.stopPropagation(), true);
    }
  }
  for (const handle of elements.editorContent.querySelectorAll("[data-phase-drag]")) {
    handle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    handle.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData("text/plain", handle.dataset.phaseDrag);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      handle.closest(".phase-card")?.classList.add("is-dragging");
    });
    handle.addEventListener("dragend", () => {
      for (const card of elements.editorContent.querySelectorAll(".phase-card")) {
        card.classList.remove("is-dragging", "is-drop-target", "drop-after");
      }
    });
  }
  for (const card of elements.editorContent.querySelectorAll("[data-phase-card]")) {
    card.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      const rect = card.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      card.classList.add("is-drop-target");
      card.classList.toggle("drop-after", after);
    });
    card.addEventListener("dragleave", () => {
      card.classList.remove("is-drop-target", "drop-after");
    });
    card.addEventListener("drop", (event) => {
      event.preventDefault();
      const payload = event.dataTransfer?.getData("text/plain") || "";
      const [sourceCycleIndex, sourcePhaseIndex] = payload.split(":").map(Number);
      const targetCycleIndex = Number(card.dataset.cycleIndex);
      const targetPhaseIndex = Number(card.dataset.phaseIndex);
      if (sourceCycleIndex !== targetCycleIndex) return;

      const rect = card.getBoundingClientRect();
      const dropAfter = event.clientY > rect.top + rect.height / 2;
      let toIndex = targetPhaseIndex + (dropAfter ? 1 : 0);
      if (sourcePhaseIndex < toIndex) toIndex -= 1;

      if (!movePhase(currentPreset(), sourceCycleIndex, sourcePhaseIndex, toIndex)) return;
      markDirty();
      renderEditor();
    });
  }
  for (const button of elements.editorContent.querySelectorAll("[data-open-editor-tab]")) {
    button.addEventListener("click", () => {
      state.editorTab = button.dataset.openEditorTab;
      renderEditor();
    });
  }

  for (const button of elements.editorContent.querySelectorAll("[data-remove-cycle-phase]")) {
    button.addEventListener("click", () => {
      const [cycleIndex, phaseIndex] = button.dataset.removeCyclePhase
        .split(":")
        .map(Number);
      currentPreset().cycles[cycleIndex].phases.splice(phaseIndex, 1);
      state.expandedPhaseKey = "";
      markDirty();
      renderEditor();
    });
  }
  for (const button of elements.editorContent.querySelectorAll("[data-add-cycle-phase]")) {
    button.addEventListener("click", () => {
      const cycleIndex = Number(button.dataset.addCyclePhase);
      const phases = currentPreset().cycles[cycleIndex].phases;
      phases.push({
        id: `phase-${phases.length + 1}`,
        name: `Phase ${phases.length + 1}`,
        objective: "",
        exchanges: 3,
        interestLevel: "medium",
        mediaProbability: 0,
        mediaSource: "none",
      });
      state.expandedPhaseKey = `${cycleIndex}:${phases.length - 1}`;
      markDirty();
      renderEditor();
    });
  }
  document.querySelector("#add-cycle")?.addEventListener("click", () => {
    const index = currentPreset().cycles.length + 1;
    currentPreset().cycles.push({
      id: `cycle-${index}`,
      name: `Cycle ${index}`,
      smartPacing: true,
      phases: [],
    });
    state.activeCycleIndex = currentPreset().cycles.length - 1;
    state.expandedPhaseKey = "";
    markDirty();
    renderEditor();
  });
  document.querySelector("#remove-cycle")?.addEventListener("click", () => {
    if (!removeCycle(currentPreset(), state.activeCycleIndex)) return;
    markDirty();
    renderEditor();
  });

  for (const button of elements.editorContent.querySelectorAll("[data-remove-cta]")) {
    button.addEventListener("click", () => {
      currentPreset().ctaScripts.splice(Number(button.dataset.removeCta), 1);
      state.expandedCtaKey = "";
      markDirty();
      renderEditor();
    });
  }
  for (const button of elements.editorContent.querySelectorAll("[data-toggle-cta-details]")) {
    button.addEventListener("click", () => {
      state.expandedCtaKey = state.expandedCtaKey === button.dataset.toggleCtaDetails
        ? ""
        : button.dataset.toggleCtaDetails;
      renderEditor();
    });
  }
  for (const button of elements.editorContent.querySelectorAll("[data-remove-cta-message]")) {
    button.addEventListener("click", () => {
      const [ctaIndex, messageIndex] = button.dataset.removeCtaMessage
        .split(":")
        .map(Number);
      currentPreset().ctaScripts[ctaIndex].messages.splice(messageIndex, 1);
      if (!currentPreset().ctaScripts[ctaIndex].messages.length) {
        currentPreset().ctaScripts[ctaIndex].messages.push({
          id: `cta-${ctaIndex + 1}-message-1`,
          text: "",
          waitForReply: false,
          mediaSource: "none",
        });
      }
      markDirty();
      renderEditor();
    });
  }
  for (const button of elements.editorContent.querySelectorAll("[data-add-cta-message]")) {
    button.addEventListener("click", () => {
      const ctaIndex = Number(button.dataset.addCtaMessage);
      const messages = currentPreset().ctaScripts[ctaIndex].messages;
      messages.push({
        id: `cta-${ctaIndex + 1}-message-${messages.length + 1}`,
        text: "",
        waitForReply: false,
        mediaSource: "none",
      });
      state.expandedCtaKey = String(ctaIndex);
      markDirty();
      renderEditor();
    });
  }
  document.querySelector("#add-cta")?.addEventListener("click", () => {
    const index = currentPreset().ctaScripts.length + 1;
    currentPreset().ctaScripts.push({
      id: `cta-${index}`,
      cycle: (Number(state.activeCycleIndex) || 0) + 1,
      title: `CTA ${index}`,
      enabled: true,
      useDefaultUrl: true,
      messages: [{
        id: `cta-${index}-message-1`,
        text: "",
        waitForReply: false,
        mediaSource: "none",
      }],
    });
    state.expandedCtaKey = String(currentPreset().ctaScripts.length - 1);
    markDirty();
    renderEditor();
  });

  for (const button of elements.editorContent.querySelectorAll("[data-remove-url]")) {
    button.addEventListener("click", () => {
      currentPreset().urls.items.splice(Number(button.dataset.removeUrl), 1);
      state.expandedUrlKey = "";
      markDirty();
      renderEditor();
    });
  }
  for (const button of elements.editorContent.querySelectorAll("[data-toggle-url-details]")) {
    button.addEventListener("click", () => {
      state.expandedUrlKey = state.expandedUrlKey === button.dataset.toggleUrlDetails
        ? ""
        : button.dataset.toggleUrlDetails;
      renderEditor();
    });
  }
  document.querySelector("#add-url")?.addEventListener("click", () => {
    const index = currentPreset().urls.items.length + 1;
    currentPreset().urls.items.push({
      id: `url-${index}`,
      platform: "Other",
      displayLabel: "plateforme privee",
      url: "",
      snapModel: "",
      spaceBeforeDotCom: false,
      enabled: true,
    });
    state.expandedUrlKey = String(currentPreset().urls.items.length - 1);
    markDirty();
    renderEditor();
  });

  for (const button of elements.editorContent.querySelectorAll("[data-remove-sprinkle]")) {
    button.addEventListener("click", () => {
      currentPreset().sprinkles.splice(Number(button.dataset.removeSprinkle), 1);
      state.expandedSprinkleKey = "";
      markDirty();
      renderEditor();
    });
  }
  for (const button of elements.editorContent.querySelectorAll("[data-toggle-sprinkle-details]")) {
    button.addEventListener("click", () => {
      state.expandedSprinkleKey = state.expandedSprinkleKey === button.dataset.toggleSprinkleDetails
        ? ""
        : button.dataset.toggleSprinkleDetails;
      renderEditor();
    });
  }
  document.querySelector("#add-sprinkle")?.addEventListener("click", () => {
    const index = currentPreset().sprinkles.length + 1;
    currentPreset().sprinkles.push({
      id: `sprinkle-${index}`,
      name: `Sprinkle ${index}`,
      messages: [""],
      mediaSource: "none",
      enabled: true,
    });
    state.expandedSprinkleKey = String(currentPreset().sprinkles.length - 1);
    markDirty();
    renderEditor();
  });

  for (const button of elements.editorContent.querySelectorAll("[data-remove-followup]")) {
    button.addEventListener("click", () => {
      currentPreset().followups.items.splice(Number(button.dataset.removeFollowup), 1);
      state.expandedFollowupKey = "";
      markDirty();
      renderEditor();
    });
  }
  for (const button of elements.editorContent.querySelectorAll("[data-toggle-followup-details]")) {
    button.addEventListener("click", () => {
      state.expandedFollowupKey = state.expandedFollowupKey === button.dataset.toggleFollowupDetails
        ? ""
        : button.dataset.toggleFollowupDetails;
      renderEditor();
    });
  }
  document.querySelector("#add-followup")?.addEventListener("click", () => {
    const index = currentPreset().followups.items.length + 1;
    currentPreset().followups.items.push({
      id: `followup-${index}`,
      title: `Relance ${index}`,
      messages: [""],
      mediaSource: "none",
      enabled: true,
    });
    state.expandedFollowupKey = String(currentPreset().followups.items.length - 1);
    markDirty();
    renderEditor();
  });

  for (const button of elements.editorContent.querySelectorAll("[data-remove-finisher]")) {
    button.addEventListener("click", () => {
      currentPreset().finishers.items.splice(Number(button.dataset.removeFinisher), 1);
      state.expandedFinisherKey = "";
      markDirty();
      renderEditor();
    });
  }
  for (const button of elements.editorContent.querySelectorAll("[data-remove-finisher-message]")) {
    button.addEventListener("click", () => {
      const [finisherIndex, messageIndex] = button.dataset.removeFinisherMessage
        .split(":")
        .map(Number);
      const messages = currentPreset().finishers.items[finisherIndex]?.messages;
      if (Array.isArray(messages)) {
        messages.splice(messageIndex, 1);
        if (!messages.length) messages.push("");
      }
      markDirty();
      renderEditor();
    });
  }
  for (const button of elements.editorContent.querySelectorAll("[data-toggle-finisher-details]")) {
    button.addEventListener("click", () => {
      state.expandedFinisherKey = state.expandedFinisherKey === button.dataset.toggleFinisherDetails
        ? ""
        : button.dataset.toggleFinisherDetails;
      renderEditor();
    });
  }
  for (const button of elements.editorContent.querySelectorAll("[data-add-finisher-message]")) {
    button.addEventListener("click", () => {
      const finisher = currentPreset().finishers.items[Number(button.dataset.addFinisherMessage)];
      if (finisher) {
        finisher.messages = Array.isArray(finisher.messages) ? finisher.messages : [];
        finisher.messages.push("");
      }
      state.expandedFinisherKey = button.dataset.addFinisherMessage;
      markDirty();
      renderEditor();
    });
  }
  document.querySelector("#add-finisher")?.addEventListener("click", () => {
    const index = currentPreset().finishers.items.length + 1;
    currentPreset().finishers.items.push({
      id: `finisher-${index}`,
      title: `Finisher ${index}`,
      useDefaultUrl: true,
      messages: [""],
      mediaSource: "none",
      enabled: true,
    });
    state.expandedFinisherKey = String(currentPreset().finishers.items.length - 1);
    markDirty();
    renderEditor();
  });

  for (const button of elements.editorContent.querySelectorAll("[data-remove-condition]")) {
    button.addEventListener("click", () => {
      currentPreset().ignoreConditions.behavioral.splice(
        Number(button.dataset.removeCondition),
        1,
      );
      markDirty();
      renderEditor();
    });
  }
  document.querySelector("#add-condition")?.addEventListener("click", () => {
    currentPreset().ignoreConditions.behavioral.push({
      description: "",
      enabled: true,
    });
    markDirty();
    renderEditor();
  });
  for (const button of elements.editorContent.querySelectorAll("[data-remove-ignore-list]")) {
    button.addEventListener("click", () => {
      currentPreset().ignoreConditions.lists.splice(
        Number(button.dataset.removeIgnoreList),
        1,
      );
      markDirty();
      renderEditor();
    });
  }
  document.querySelector("#add-ignore-list")?.addEventListener("click", () => {
    const index = currentPreset().ignoreConditions.lists.length + 1;
    currentPreset().ignoreConditions.lists.push({
      name: `Liste ${index}`,
      enabled: true,
      entries: [],
    });
    markDirty();
    renderEditor();
  });
}

function renderEditor() {
  const preset = currentPreset();
  if (!preset) {
    elements.presetHeading.textContent = "Aucun preset actif";
    elements.editorContent.innerHTML = '<p class="field-help">Crée un preset avec le bouton + ou restaure un preset depuis les Archives.</p>';
    return;
  }
  const renderers = {
    optimizations: renderOptimizations,
    main: renderMainSettings,
    openers: renderOpenersCapital,
    phases: renderCycles,
    cta: renderCtaScriptsCapital,
    urls: renderUrls,
    objections: renderAdvancedObjections,
    sprinkles: renderSprinklesCapital,
    followups: renderFollowupsCapital,
    finishers: renderFinishersCards,
    ignorelist: renderIgnoreConditions,
    media: renderMedia,
  };
  if (!renderers[state.editorTab]) state.editorTab = "main";
  elements.presetHeading.textContent = `${preset.name} (${preset.id})`;
  elements.presetCtaToggle.checked = preset.strategy.ctaEnabled;
  for (const tab of elements.editorTabs.querySelectorAll("[data-tab]")) {
    tab.classList.toggle("active", tab.dataset.tab === state.editorTab);
  }
  updatePageHeader();
  syncNavigation();
  elements.editorContent.innerHTML = sectionIoBar(state.editorTab) + renderers[state.editorTab](preset);
  bindEditorControls();
}

function renderStudio() {
  if (!state.config) return;
  const presets = activePresets();
  if (!presets.some(p => p.id === state.selectedPresetId)) state.selectedPresetId = presets[0]?.id || null;
  const empty = !presets.length;
  for (const button of [elements.duplicatePreset, elements.exportPreset, elements.deletePreset, document.getElementById("archive-preset")]) {
    if (button) button.disabled = empty || presetArchiveBusy;
  }
  elements.presetCtaToggle.disabled = empty;
  elements.editorTabs.hidden = empty;
  renderPresetList();
  renderPresetOrganizer();
  renderEditor();
}

let presetArchiveBusy = false;

function renderPresetArchives() {
  const container = document.getElementById("preset-archives-list");
  if (!container) return;
  const archived = configPresets().filter(preset => preset.archivedAt);
  document.getElementById("preset-archives-count").textContent = `${archived.length} preset${archived.length > 1 ? "s" : ""} archivé${archived.length > 1 ? "s" : ""}`;
  container.innerHTML = archived.length ? archived.map(preset => `
    <article class="api-key-card">
      <h3>${escapeHtml(preset.name)}</h3>
      <p class="field-help">Archivé le ${escapeHtml(new Date(preset.archivedAt).toLocaleDateString("fr-FR"))} · ID ${escapeHtml(preset.id)}</p>
      <button type="button" class="button secondary" data-restore-preset="${escapeHtml(preset.id)}" ${presetArchiveBusy ? "disabled" : ""}>Restaurer</button>
    </article>
  `).join("") : '<div class="api-key-card"><h3>Aucun preset archivé</h3><p>Le bouton « Archiver » du studio permet de ranger ici les presets que tu veux conserver.</p></div>';
  for (const button of container.querySelectorAll("[data-restore-preset]")) {
    button.addEventListener("click", () => setPresetArchived(button.dataset.restorePreset, false));
  }
}

async function setPresetArchived(id, archived) {
  if (presetArchiveBusy || elements.saveButton.disabled) return;
  const preset = configPresets().find(p => p.id === id);
  if (!preset) return;
  const previous = preset.archivedAt;
  const wasDirty = state.dirty;
  const selected = state.selectedPresetId;
  presetArchiveBusy = true;
  preset.archivedAt = archived ? new Date().toISOString() : null;
  markDirty();
  renderStudio();
  renderPresetArchives();
  try {
    if (await saveStudio()) {
      if (!archived) state.selectedPresetId = id;
      showToast(archived ? "Preset archivé." : "Preset restauré.");
    } else {
      preset.archivedAt = previous;
      state.selectedPresetId = selected;
      if (wasDirty) markDirty(); else markSaved();
    }
  } finally {
    presetArchiveBusy = false;
    renderStudio();
    renderPresetArchives();
  }
}

function mediaVaultAccountOptions() {
  return [
    { id: "", name: "Media Vault du preset" },
    ...(state.mediaLibrary?.vaults || []),
  ];
}

function adspowerProxyOptions() {
  return (state.adspowerProxies || []).map((proxy) => {
    const endpoint = [proxy.host, proxy.port].filter(Boolean).join(":");
    const details = [proxy.remark, proxy.type?.toUpperCase(), endpoint]
      .filter(Boolean)
      .join(" - ");
    return `
      <option value="${escapeHtml(proxy.id)}">
        ${escapeHtml(details || proxy.id)} (${escapeHtml(proxy.id)})
      </option>
    `;
  }).join("");
}

function syncChatNowProxyFields(form) {
  if (!form) return;
  const mode = String(form.elements.proxyMode?.value || "none");
  for (const field of form.querySelectorAll("[data-proxy-mode]")) {
    field.hidden = field.dataset.proxyMode !== mode;
  }
}

async function loadAdspowerProxies() {
  try {
    const payload = await api("/api/adspower/proxies");
    state.adspowerProxies = Array.isArray(payload.proxies) ? payload.proxies : [];
  } catch {
    state.adspowerProxies = [];
  }
}

async function loadMailboxes() {
  try {
    const payload = await api("/api/mailboxes");
    state.mailboxes = Array.isArray(payload.mailboxes) ? payload.mailboxes : [];
  } catch {
    state.mailboxes = [];
  }
}

function availableMailboxOptions() {
  const available = state.mailboxes.filter((mailbox) => mailbox.status === "available");
  return available.map((mailbox) => `
    <option value="${escapeHtml(mailbox.id)}">
      ${escapeHtml(mailbox.email)} - ${escapeHtml(mailbox.provider)}
    </option>
  `).join("");
}

function mailboxPoolRows() {
  if (!state.mailboxes.length) {
    return '<p class="mailbox-empty">Aucune adresse importee.</p>';
  }
  return state.mailboxes.map((mailbox) => `
    <div class="mailbox-row">
      <span>
        <strong>${escapeHtml(mailbox.email)}</strong>
        <small>${escapeHtml(mailbox.provider)}</small>
      </span>
      <span class="mailbox-row-actions">
        <span class="mailbox-status ${mailbox.status === "available" ? "available" : "assigned"}">
          ${mailbox.status === "available"
            ? "Disponible"
            : `Attribuee a ${escapeHtml(mailbox.assignedAccount || "un compte")}`}
        </span>
        ${mailbox.status === "available" ? `
          <button
            type="button"
            class="mailbox-delete-button"
            data-mailbox-delete="${escapeHtml(mailbox.id)}"
            aria-label="Supprimer ${escapeHtml(mailbox.email)}"
            title="Supprimer"
          >×</button>
        ` : ""}
      </span>
    </div>
  `).join("");
}

async function deleteChatNowMailbox(mailboxId) {
  if (!mailboxId) return;
  try {
    const payload = await api(`/api/mailboxes/${encodeURIComponent(mailboxId)}`, {
      method: "DELETE",
    });
    state.mailboxes = Array.isArray(payload.mailboxes) ? payload.mailboxes : [];
    renderChatNowAddAccount();
    showToast("Adresse e-mail supprimee.");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function importChatNowMailboxes() {
  const textarea = document.querySelector("#chatnow-mailbox-import");
  const button = document.querySelector("#chatnow-mailbox-import-button");
  if (!textarea || !button) return;
  const text = textarea.value.trim();
  if (!text) {
    showToast("Ajoute au moins une adresse email:mot_de_passe.", "error");
    return;
  }
  button.disabled = true;
  button.textContent = "Import...";
  try {
    const payload = await api("/api/mailboxes/import", {
      method: "POST",
      body: { text },
    });
    state.mailboxes = Array.isArray(payload.mailboxes) ? payload.mailboxes : [];
    textarea.value = "";
    renderChatNowAddAccount();
    const rejected = Array.isArray(payload.rejectedLines) && payload.rejectedLines.length
      ? ` ${payload.rejectedLines.length} ligne(s) ignoree(s).`
      : "";
    showToast(`${payload.imported} adresse(s) ajoutee(s), ${payload.updated} mise(s) a jour.${rejected}`);
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Importer";
  }
}

function renderChatNowAddAccount() {
  if (!elements.chatnowAddAccount || !state.config) return;
  const presets = configPresets();
  const selectedPreset = currentPreset() || presets[0];
  const presetOptions = presetOptionsHtml(presets, selectedPreset?.id, (preset) => `${preset.name} (${preset.id})`);
  const mediaVaultOptions = mediaVaultAccountOptions().map((vault) => `
    <option value="${escapeHtml(vault.id)}">
      ${escapeHtml(vault.name)}${vault.id ? ` (${escapeHtml(vault.id)})` : ""}
    </option>
  `).join("");
  const savedProxyOptions = adspowerProxyOptions();
  const mailboxOptions = availableMailboxOptions();
  const availableMailboxCount = state.mailboxes.filter(
    (mailbox) => mailbox.status === "available",
  ).length;

  elements.chatnowAddAccount.innerHTML = `
    <form id="chatnow-add-account-form" class="chatnow-add-account-card">
      <div class="chatnow-add-header">
        <div>
          <strong>Ajouter un compte ChatNow</strong>
          <span>Creer la config BambouAI + le worker liveview pour un profil AdsPower.</span>
        </div>
        <button type="submit" class="button primary">Creer le compte</button>
      </div>
      <div class="chatnow-add-grid">
        <div class="field">
          <label>Nom de la modele</label>
          <input name="modelName" placeholder="Lina" required>
        </div>
        <div class="field">
          <label>ID profil AdsPower</label>
          <input name="profileId" placeholder="Vide = creation auto">
        </div>
        <div class="field">
          <label>Port worker</label>
          <input name="port" type="number" min="1024" max="65535" placeholder="Auto">
        </div>
        <div class="field">
          <label>Preset</label>
          <select name="presetId" ${presets.length ? "" : "disabled"}>${presetOptions}</select>
        </div>
        <div class="field">
          <label>Media Vault</label>
          <select name="mediaVaultId">${mediaVaultOptions}</select>
        </div>
        <div class="field">
          <label>Ville</label>
          <input name="city" placeholder="Paris">
        </div>
        <div class="field">
          <label>Adresse e-mail ChatNow</label>
          <select name="mailboxId">
            <option value="" ${availableMailboxCount ? "" : "selected"}>Aucune / compte deja existant</option>
            <option value="auto" ${availableMailboxCount ? "selected" : "disabled"}>
              Attribution automatique (${availableMailboxCount} disponible${availableMailboxCount > 1 ? "s" : ""})
            </option>
            ${mailboxOptions}
          </select>
        </div>
        <div class="field">
          <label>Proxy</label>
          <select name="proxyMode">
            <option value="none">Sans proxy</option>
            <option value="random">Aleatoire depuis AdsPower</option>
            <option value="saved">Proxy AdsPower enregistre</option>
            <option value="custom">Proxy personnalise</option>
          </select>
        </div>
        <div class="field proxy-config-field" data-proxy-mode="saved" hidden>
          <label>Proxy AdsPower</label>
          <select name="proxyId">
            ${savedProxyOptions || '<option value="">Aucun proxy enregistre trouve</option>'}
          </select>
        </div>
        <div class="field proxy-config-field" data-proxy-mode="custom" hidden>
          <label>Type</label>
          <select name="proxyType">
            <option value="http">HTTP</option>
            <option value="https">HTTPS</option>
            <option value="socks5">SOCKS5</option>
          </select>
        </div>
        <div class="field proxy-config-field" data-proxy-mode="custom" hidden>
          <label>Adresse proxy</label>
          <input name="proxyHost" placeholder="proxy.exemple.com">
        </div>
        <div class="field proxy-config-field" data-proxy-mode="custom" hidden>
          <label>Port proxy</label>
          <input name="proxyPort" type="number" min="1" max="65535" placeholder="8000">
        </div>
        <div class="field proxy-config-field" data-proxy-mode="custom" hidden>
          <label>Utilisateur proxy</label>
          <input name="proxyUsername" autocomplete="off" placeholder="Optionnel">
        </div>
        <div class="field proxy-config-field" data-proxy-mode="custom" hidden>
          <label>Mot de passe proxy</label>
          <input name="proxyPassword" type="password" autocomplete="new-password" placeholder="Optionnel">
        </div>
        <label class="toggle-field">
          <span>Compte actif</span>
          <input name="enabled" type="checkbox" checked>
        </label>
        <label class="toggle-field">
          <span>Reponse auto</span>
          <input name="autoReply" type="checkbox" checked>
        </label>
        <label class="toggle-field">
          <span>Recreer si trigger</span>
          <input name="recreateOnTrigger" type="checkbox">
        </label>
        <div class="field">
          <label>Trigger recreation</label>
          <select name="recreateTrigger">
            ${recreateTriggerOptionMarkup("chatnow_ban")}
          </select>
        </div>
        <label class="toggle-field">
          <span>Creer profil AdsPower si vide</span>
          <input name="createAdspowerProfile" type="checkbox" checked>
        </label>
        <label class="toggle-field">
          <span>Inscription e-mail ChatNow</span>
          <input name="registerEmail" type="checkbox" checked>
        </label>
      </div>
      <p class="field-help">
        Laisse l'ID vide pour creer automatiquement un profil AdsPower sur le PC host. Si une adresse est attribuee, BambouAI ouvre l'inscription e-mail ChatNow, recupere le mail GMX en IMAP, puis exporte la session.
      </p>
    </form>
    <section class="mailbox-pool" aria-labelledby="mailbox-pool-title">
      <div class="mailbox-pool-header">
        <div>
          <strong id="mailbox-pool-title">Pool d'e-mails</strong>
          <span>${availableMailboxCount} disponible${availableMailboxCount > 1 ? "s" : ""} sur ${state.mailboxes.length}</span>
        </div>
        <button id="chatnow-mailbox-import-button" type="button" class="button secondary">Importer</button>
      </div>
      <div class="mailbox-import-grid">
        <div class="field">
          <label for="chatnow-mailbox-import">Comptes GMX / Hotmail</label>
          <textarea id="chatnow-mailbox-import" rows="4" placeholder="email@gmx.com:mot_de_passe"></textarea>
          <small>Une adresse par ligne. Les mots de passe sont chiffres et ne sont jamais reaffiches.</small>
        </div>
        <div class="mailbox-list" aria-label="Adresses e-mail importees">
          ${mailboxPoolRows()}
        </div>
      </div>
    </section>
  `;

  const form = document.querySelector("#chatnow-add-account-form");
  form?.addEventListener("submit", createChatNowAccount);
  form?.elements.proxyMode?.addEventListener("change", () => syncChatNowProxyFields(form));
  document.querySelector("#chatnow-mailbox-import-button")
    ?.addEventListener("click", importChatNowMailboxes);
  for (const button of document.querySelectorAll("[data-mailbox-delete]")) {
    button.addEventListener("click", () => deleteChatNowMailbox(button.dataset.mailboxDelete));
  }
  syncChatNowProxyFields(form);
}

async function createChatNowAccount(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type='submit']");
  const data = new FormData(form);
  const port = Number(data.get("port") || 0);
  const proxyMode = String(data.get("proxyMode") || "none");
  const body = {
    modelName: String(data.get("modelName") || data.get("name") || "").trim(),
    profileId: String(data.get("profileId") || "").trim(),
    port: port || undefined,
    presetId: String(data.get("presetId") || ""),
    mediaVaultId: String(data.get("mediaVaultId") || ""),
    mailboxId: String(data.get("mailboxId") || ""),
    city: String(data.get("city") || "").trim(),
    enabled: Boolean(form.elements.enabled.checked),
    autoReply: Boolean(form.elements.autoReply.checked),
    recreateOnTrigger: Boolean(form.elements.recreateOnTrigger?.checked),
    recreateTrigger: normalizeRecreateTrigger(String(data.get("recreateTrigger") || "")),
    createAdspowerProfile: Boolean(form.elements.createAdspowerProfile.checked),
    registerEmail: Boolean(form.elements.registerEmail?.checked),
    proxy: {
      mode: proxyMode,
      proxyId: String(data.get("proxyId") || "").trim(),
      type: String(data.get("proxyType") || "http"),
      host: String(data.get("proxyHost") || "").trim(),
      port: Number(data.get("proxyPort") || 0),
      username: String(data.get("proxyUsername") || "").trim(),
      password: String(data.get("proxyPassword") || ""),
    },
  };
  button.disabled = true;
  button.textContent = "Creation...";
  try {
    if (state.dirty) await saveStudio();
    const payload = await api("/api/accounts", {
      method: "POST",
      body,
    });
    await applyPayloadConfig(payload);
    await loadMailboxes();
    markSaved();
    form.reset();
    if (state.dashboard) {
      await loadDashboard({ quiet: true });
    } else {
      renderChatNowAccountSettings();
    }
    const profileNotice = payload.adspowerProfile?.created
      ? `Profil AdsPower cree: ${payload.profileId}. `
      : "";
    const exportNotice = payload.sessionExport?.ok
      ? "Session AdsPower exportee."
      : `${profileNotice}Export AdsPower echoue: ${payload.sessionExport?.reason || "session introuvable"}`;
    const registrationNotice = payload.registration?.confirmed
      ? " Inscription e-mail confirmee."
      : payload.registration?.attempted
        ? ` Inscription e-mail non terminee: ${payload.registration.reason || "verification requise"}.`
        : "";
    const message = payload.worker?.started
      ? `Compte ${payload.assignment.name} cree et worker lance sur le port ${payload.port}.${registrationNotice}`
      : `Compte ${payload.assignment.name} cree. ${exportNotice}${registrationNotice}`;
    showToast(message, payload.worker?.started ? "success" : "error");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Creer le compte";
  }
}

function renderAccountConfigRows() {
  if (!state.config) return;
  const presets = configPresets();
  const mediaVaultOptions = mediaVaultAccountOptions();
  const liveAccounts = new Map((state.dashboard?.accounts || []).map((account) => [
    account.id,
    account,
  ]));
  return state.config.accounts.map((account, index) => {
    const liveAccount = liveAccounts.get(account.id);
    const replacementId = account.replacementAccountId || liveAccount?.replacementAccountId;
    const replacementName = account.replacementAccountName || liveAccount?.replacementAccountName;
    const recreateError = account.recreateError || liveAccount?.recreateError;
    const recreateTrigger = normalizeRecreateTrigger(account.recreateTrigger);
    const triggerLabel = recreateTriggerLabel(recreateTrigger);
    const accountModelName = String(account.modelName || account.name || "")
      .replace(/\d{3,5}$/u, "")
      .trim();
    const recreationHint = replacementId
      ? `Remplacement cree: ${escapeHtml(replacementName || replacementId)}`
      : recreateError
        ? `Recreation echouee: ${escapeHtml(recreateError)}`
        : account.recreateOnTrigger
          ? `Si le trigger "${escapeHtml(triggerLabel)}" arrive, BambouAI tente de creer un remplacement.`
          : "";
    return `
    <div class="account-config-row">
      <div class="account-identity">
        <span class="account-avatar">${escapeHtml(account.name[0] || "?")}</span>
        <span>
          <strong>${escapeHtml(account.name)}</strong>
          <span>${escapeHtml(account.profileId || account.id)}${account.port ? ` - ${escapeHtml(account.port)}` : ""}</span>
          <span class="field-help">Modele: ${escapeHtml(accountModelName || "Bambou")}</span>
          ${(account.discardedAt || liveAccount?.discarded || liveAccount?.banned) ? `<span class="field-help">Compte jete: remplace la session avant de relancer l'IA.</span>` : ""}
          ${recreationHint ? `<span class="field-help">${recreationHint}</span>` : ""}
        </span>
      </div>
      <div class="field">
        <label>Nom de la modele</label>
        <input data-config-path="accounts.${index}.modelName" value="${escapeHtml(accountModelName || "Bambou")}" placeholder="Lina">
      </div>
      <div class="field">
        <label>Preset attribué</label>
        <select data-config-path="accounts.${index}.presetId">
          ${presets.map((preset) => `
            <option value="${escapeHtml(preset.id)}" ${preset.id === account.presetId ? "selected" : ""}>
              ${escapeHtml(preset.name)} (${escapeHtml(preset.id)})
            </option>
          `).join("")}
        </select>
      </div>
      <div class="field">
        <label>Ville du compte ChatNow</label>
        <input data-config-path="accounts.${index}.city" value="${escapeHtml(account.city || "")}" placeholder="Paris">
      </div>
      <div class="field">
        <label>Profil AdsPower</label>
        <input data-config-path="accounts.${index}.profileId" value="${escapeHtml(account.profileId || "")}" placeholder="k1e25xk5">
      </div>
      <div class="field">
        <label>Media Vault attribue</label>
        <select data-config-path="accounts.${index}.mediaVaultId">
          ${mediaVaultOptions.map((vault) => `
            <option value="${escapeHtml(vault.id)}" ${vault.id === (account.mediaVaultId || "") ? "selected" : ""}>
              ${escapeHtml(vault.name)}${vault.id ? ` (${escapeHtml(vault.id)})` : ""}
            </option>
          `).join("")}
        </select>
      </div>
      ${toggle("Compte actif", `accounts.${index}.enabled`, account.enabled, "config")}
      ${toggle("Réponse auto", `accounts.${index}.autoReply`, account.autoReply, "config")}
      ${toggle("Recreer si trigger", `accounts.${index}.recreateOnTrigger`, Boolean(account.recreateOnTrigger), "config")}
      <div class="field">
        <label>Trigger recreation</label>
        <select data-config-path="accounts.${index}.recreateTrigger">
          ${recreateTriggerOptionMarkup(recreateTrigger)}
        </select>
      </div>
      <button
        type="button"
        class="button secondary account-session-export"
        data-account-id="${escapeHtml(account.id)}"
        data-account-index="${index}"
      >${(account.discardedAt || liveAccount?.discarded || liveAccount?.banned) ? "Remplacer session" : "Exporter session"}</button>
      ${account.mailboxId || account.email ? `
        <button
          type="button"
          class="button secondary account-email-register"
          data-account-id="${escapeHtml(account.id)}"
          data-account-index="${index}"
        >Finaliser e-mail</button>
      ` : ""}
      <button
        type="button"
        class="button secondary account-delete"
        data-account-id="${escapeHtml(account.id)}"
        data-account-index="${index}"
      >Supprimer</button>
    </div>
  `;
  }).join("");

}

function renderChatNowAccountSettings() {
  if (!elements.chatnowAccountConfigList || !state.config) return;
  renderChatNowAddAccount();
  elements.chatnowAccountConfigList.innerHTML = renderAccountConfigRows() || "";
  bindConfigControls(elements.chatnowAccountConfigList);
  bindChatNowAccountActions(elements.chatnowAccountConfigList);
}

// Une carte par fournisseur du catalogue de moteurs (un hôte = une clé, comme côté serveur).
// null tant que le catalogue n'est pas connu : la page garde alors la carte unique d'origine.
function engineKeyEntries() {
  const profiles = state.engineProfiles?.profiles || [];
  if (!profiles.length) return null;
  const activeId = activeEngineProfile()?.id;
  const providers = new Map();
  for (const profile of profiles) {
    let host;
    try { host = new URL(profile.baseUrl).host; } catch { host = String(profile.baseUrl || profile.id); }
    if (!providers.has(host)) providers.set(host, []);
    providers.get(host).push(profile);
  }
  const names = { "api.routeway.ai": "Routeway", "api.xiaomimimo.com": "Xiaomi MiMo" };
  return [...providers.entries()].map(([host, group], index) => {
    const active = group.some((profile) => profile.id === activeId);
    return {
      id: `engine-h${index}`,
      profileId: group[0].id,
      active,
      label: `Moteur IA — ${escapeHtml(names[host] || host)}${active ? " (actif)" : ""}`,
      endpoint: "/api/studio/engine-profile-key",
      configured: group.some((profile) => profile.keyConfigured),
      placeholder: "sk-...",
      help: `Clé de ${escapeHtml(host)}, utilisée par : ${group.map((profile) => escapeHtml(profile.label)).join(", ")}.`,
    };
  });
}

// --- Clés d'accès des assistants (Settings > API Keys) : créer, régler, mettre en pause, révoquer ---
// Le serveur ne garde que l'empreinte de chaque clé : le clair n'existe qu'ici, une seule fois, à la création.
function assistantUi() {
  return (state.assistantUi ||= { keys: null, error: "", reveal: null, form: null, loading: false, seq: 0 });
}

// Une seule voie pour lire la liste : si deux lectures se croisent, la plus récente gagne.
// Un échec n'efface pas la liste déjà affichée : il pose un bandeau d'erreur.
async function loadAssistantKeys() {
  const ui = assistantUi();
  const seq = ++ui.seq;
  try {
    const keys = (await api("/api/studio/api-keys")).keys || [];
    if (seq === ui.seq) {
      ui.keys = keys;
      ui.error = "";
    }
    return true;
  } catch (error) {
    if (seq === ui.seq) ui.error = ui.keys ? `Liste non actualisée : ${error.message}` : error.message;
    return false;
  }
}

async function refreshAssistantKeys() {
  const ui = assistantUi();
  if (ui.loading) return;
  ui.loading = true;
  try {
    await loadAssistantKeys();
  } finally {
    ui.loading = false;
  }
  // un formulaire ouvert garde ce qui y est tapé : on ne le redessine pas sous les doigts
  if (state.activeView === "apikeys" && !ui.form) renderAssistantKeys();
}

// Avant tout redessin, ce qui est tapé dans le formulaire repasse dans l'état : un clic sur « Pause » ne le vide pas.
function captureAssistantForm() {
  const ui = assistantUi();
  const element = document.querySelector("#assistant-keys [data-assistant-form]");
  if (!element || !ui.form) return;
  const data = new FormData(element);
  ui.form.label = String(data.get("label") || "");
  for (const name of ["rpm", "maxConcurrent", "dailyLimit"]) {
    const value = data.get(name);
    if (value !== null) ui.form[name] = String(value);
  }
  ui.form.mode = data.get("presetMode") === "some" ? "some" : "all";
  ui.form.presetIds = data.getAll("preset").map(String);
}

function assistantKeyAgo(iso) {
  const time = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(time)) return "aucun appel";
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return "à l'instant";
  if (seconds < 3600) return `il y a ${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `il y a ${Math.round(seconds / 3600)} h`;
  return `il y a ${Math.round(seconds / 86400)} j`;
}

function assistantKeyPresetsText(key) {
  if (!key.presetIds.length) return "Tous les presets";
  const names = key.presetIds.map((id) => configPresets().find((preset) => String(preset.id) === id)?.name || `#${id}`);
  return names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} +${names.length - 3}`;
}

function assistantKeyRow(key) {
  const status = key.revokedAt ? ["revoked", "Révoquée"] : key.disabled ? ["paused", "En pause"] : ["configured", "Active"];
  const id = escapeHtml(key.id);
  const actions = key.revokedAt ? "" : `
    <div class="assistant-key-actions">
      <button type="button" class="button secondary" data-assistant-action="edit" data-key-id="${id}">Modifier</button>
      <button type="button" class="button secondary" data-assistant-action="${key.disabled ? "resume" : "pause"}" data-key-id="${id}">${key.disabled ? "Reprendre" : "Mettre en pause"}</button>
      <button type="button" class="button danger" data-assistant-action="revoke" data-key-id="${id}">Révoquer</button>
    </div>`;
  const usage = key.revokedAt
    ? `Révoquée le ${escapeHtml(new Date(key.revokedAt).toLocaleString("fr-FR"))}`
    : `Générations aujourd'hui (UTC) : ${key.callsToday} / ${key.dailyLimit} · appels depuis le démarrage du serveur : ${key.callsSinceStart} · dernier appel : ${escapeHtml(assistantKeyAgo(key.lastUsedAt))}`;
  return `
    <div class="assistant-key-row ${key.revokedAt ? "revoked" : ""}" data-key-id="${id}">
      <div class="assistant-key-top">
        <strong>${escapeHtml(key.label)}</strong>
        <span class="api-key-badge ${status[0]}">${status[1]}</span>
        <code class="assistant-key-hint">bbk_…${escapeHtml(key.hint)}</code>
      </div>
      <dl class="assistant-key-meta">
        <div><dt>Presets</dt><dd>${escapeHtml(assistantKeyPresetsText(key))}</dd></div>
        <div><dt>Limites</dt><dd>${key.rpm} / min · ${key.maxConcurrent} simultanée${key.maxConcurrent > 1 ? "s" : ""} · ${key.dailyLimit} / jour</dd></div>
        <div><dt>Usage</dt><dd>${usage}</dd></div>
        <div><dt>Créée</dt><dd>${escapeHtml(new Date(key.createdAt).toLocaleString("fr-FR"))} · ${id}</dd></div>
      </dl>
      ${actions}
    </div>`;
}

function assistantKeyForm(form) {
  const presets = configPresets();
  const all = (form.mode || (form.presetIds.length ? "some" : "all")) === "all";
  const list = presets.length
    ? presets.map((preset) => {
      const id = String(preset.id);
      return `
        <label class="assistant-preset">
          <input type="checkbox" name="preset" value="${escapeHtml(id)}" ${form.presetIds.includes(id) ? "checked" : ""}>
          <span>${escapeHtml(preset.name || id)}</span>
          <small>${preset.archivedAt ? "archivé · " : ""}ID ${escapeHtml(id)}</small>
        </label>`;
    }).join("")
    : '<p class="api-key-help">Aucun preset dans la configuration.</p>';
  return `
    <form class="assistant-key-form" data-assistant-form="${escapeHtml(form.id || "")}" autocomplete="off">
      <h4>${form.id ? "Modifier la clé" : "Nouvelle clé"}</h4>
      <div class="field">
        <label for="assistant-key-label">Nom (qui s'en sert)</label>
        <input id="assistant-key-label" type="text" name="label" maxlength="60" required value="${escapeHtml(form.label)}" placeholder="Assistant de Michel">
      </div>
      <div class="assistant-key-limits">
        <div class="field"><label for="assistant-key-rpm">Par minute</label><input id="assistant-key-rpm" type="number" name="rpm" min="1" max="600" step="1" required value="${escapeHtml(String(form.rpm))}"></div>
        <div class="field"><label for="assistant-key-concurrent">Simultanées</label><input id="assistant-key-concurrent" type="number" name="maxConcurrent" min="1" max="8" step="1" required value="${escapeHtml(String(form.maxConcurrent))}"></div>
        <div class="field"><label for="assistant-key-daily">Par jour (UTC)</label><input id="assistant-key-daily" type="number" name="dailyLimit" min="1" max="100000" step="1" required value="${escapeHtml(String(form.dailyLimit))}"></div>
      </div>
      <div class="field">
        <span class="field-label">Presets utilisables</span>
        <label class="assistant-radio"><input type="radio" name="presetMode" value="all" ${all ? "checked" : ""}> Tous mes presets, y compris ceux que je créerai plus tard</label>
        <label class="assistant-radio"><input type="radio" name="presetMode" value="some" ${all ? "" : "checked"}> Seulement ceux-ci :</label>
        <fieldset class="assistant-preset-list" ${all ? "disabled" : ""}>${list}</fieldset>
      </div>
      <p class="assistant-key-error" role="alert" hidden></p>
      <div class="assistant-key-actions">
        <button type="submit" class="button primary">${form.id ? "Enregistrer" : "Créer la clé"}</button>
        <button type="button" class="button secondary" data-assistant-action="cancel">Annuler</button>
      </div>
    </form>`;
}

function assistantKeyReveal(reveal) {
  return `
    <div class="assistant-key-reveal" role="status">
      <strong>Clé « ${escapeHtml(reveal.label)} » créée : copie-la maintenant</strong>
      <p class="assistant-key-note">Elle ne sera plus jamais affichée : le serveur n'en garde que l'empreinte. Si tu la perds, révoque-la et crées-en une autre.</p>
      <div class="api-key-input-row">
        <input type="text" id="assistant-key-reveal-input" readonly value="${escapeHtml(reveal.key)}">
        <button type="button" class="button primary" data-assistant-action="copy">Copier</button>
      </div>
      <p class="assistant-key-note">À envoyer dans <code>Authorization: Bearer &lt;clé&gt;</code> vers <code>${escapeHtml(location.origin)}/api/assistant/presets</code> et <code>/api/assistant/generate</code>. Détails : <a href="/api-docs.html#assistant" target="_blank" rel="noopener">documentation API</a>.</p>
      <button type="button" class="button secondary" data-assistant-action="dismiss">J'ai copié la clé</button>
    </div>`;
}

function renderAssistantKeys() {
  const container = document.getElementById("assistant-keys");
  if (!container) return;
  captureAssistantForm();
  const ui = assistantUi();
  const keys = ui.keys || [];
  const live = keys.filter((key) => !key.revokedAt);
  const revoked = keys.filter((key) => key.revokedAt);
  const failure = ui.error ? `<p class="assistant-key-error" role="alert">${escapeHtml(ui.error)}</p>` : "";
  let body;
  if (ui.keys === null && !ui.error) {
    body = '<p class="assistant-key-note">Chargement…</p>';
    refreshAssistantKeys();
  } else if (ui.keys === null) {
    body = failure;
  } else {
    body = `
      ${failure}
      ${ui.reveal ? assistantKeyReveal(ui.reveal) : ""}
      ${ui.form ? assistantKeyForm(ui.form) : ""}
      ${live.length ? live.map(assistantKeyRow).join("") : (ui.form ? "" : '<p class="assistant-key-note">Aucune clé pour l\'instant. Crée-en une pour chaque assistant : tu pourras la couper sans toucher aux autres.</p>')}
      ${revoked.length ? `<details class="assistant-key-revoked"><summary>Clés révoquées (${revoked.length})</summary>${revoked.map(assistantKeyRow).join("")}</details>` : ""}`;
  }
  container.innerHTML = `
    <div class="api-key-card assistant-keys-card">
      <div class="api-key-header">
        <div class="api-key-label">
          <strong>Clés pour assistants</strong>
          <span class="api-key-badge ${live.some((key) => !key.disabled) ? "configured" : "missing"}">${live.length} clé${live.length > 1 ? "s" : ""}</span>
        </div>
        <div class="assistant-key-actions assistant-key-head-actions">
          <button type="button" class="button ghost" data-assistant-action="refresh">Actualiser</button>
          <button type="button" class="button primary" data-assistant-action="new" ${ui.form ? "disabled" : ""}>Nouvelle clé</button>
        </div>
      </div>
      <p class="assistant-key-note">Un assistant se connecte à l'IA de ce serveur avec sa propre clé : il peut lister tes presets et générer des réponses avec, rien d'autre (pas de configuration, pas de comptes, pas de flotte). Tu règles ses presets et ses limites ici, tu le mets en pause ou tu le révoques à tout moment, sans toucher aux extensions. La clé des extensions n'est pas gérée ici : ne la donne pas à un assistant.</p>
      ${body}
    </div>`;
  if (!container.dataset.bound) {
    container.dataset.bound = "1";
    container.addEventListener("click", handleAssistantKeyClick);
    container.addEventListener("submit", handleAssistantKeySubmit);
    container.addEventListener("change", (event) => {
      if (event.target.name !== "presetMode") return;
      const list = container.querySelector(".assistant-preset-list");
      if (list) list.disabled = event.target.value === "all";
    });
  }
}

async function assistantKeyCall(button, work) {
  const ui = assistantUi();
  let done = false;
  if (button) button.disabled = true;
  try {
    await work(ui);
    done = true;
  } catch (error) {
    showToast(error.message, "error");
  }
  // la liste est relue même après un échec : l'action a pu passer côté serveur
  await loadAssistantKeys();
  if (button) button.disabled = false;
  renderAssistantKeys();
  return done;
}

async function handleAssistantKeyClick(event) {
  const button = event.target.closest("[data-assistant-action]");
  if (!button || button.disabled) return;
  const ui = assistantUi();
  const action = button.dataset.assistantAction;
  const key = ui.keys?.find((entry) => entry.id === button.dataset.keyId);
  if (action === "new") {
    ui.form = { id: null, label: "", rpm: 20, maxConcurrent: 2, dailyLimit: 1000, presetIds: [], mode: "all" };
    renderAssistantKeys();
  } else if (action === "edit" && key) {
    ui.form = { id: key.id, label: key.label, rpm: key.rpm, maxConcurrent: key.maxConcurrent, dailyLimit: key.dailyLimit, presetIds: [...key.presetIds], mode: key.presetIds.length ? "some" : "all" };
    renderAssistantKeys();
  } else if (action === "cancel") {
    ui.form = null;
    renderAssistantKeys();
  } else if (action === "dismiss") {
    ui.reveal = null;
    renderAssistantKeys();
  } else if (action === "refresh") {
    button.disabled = true;
    await refreshAssistantKeys();
    button.disabled = false;
  } else if (action === "copy" && ui.reveal) {
    const input = document.getElementById("assistant-key-reveal-input");
    let copied = false;
    try {
      await navigator.clipboard.writeText(ui.reveal.key);
      copied = true;
    } catch {
      input?.select();
      try {
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      }
    }
    if (copied) showToast("Clé copiée.");
    else showToast("Copie impossible : la clé est sélectionnée, copie-la à la main.", "error");
  } else if ((action === "pause" || action === "resume") && key) {
    const done = await assistantKeyCall(button, () => api(`/api/studio/api-keys/${encodeURIComponent(key.id)}`, { method: "PATCH", body: { disabled: action === "pause" } }));
    if (done) showToast(action === "pause" ? `« ${key.label} » est en pause : ses appels sont refusés.` : `« ${key.label} » est reprise.`);
  } else if (action === "revoke" && key) {
    if (!window.confirm(`Révoquer la clé « ${key.label} » ?\n\nSes appels seront refusés immédiatement. C'est définitif : pour la remplacer, il faudra créer une nouvelle clé.`)) return;
    const done = await assistantKeyCall(button, () => api(`/api/studio/api-keys/${encodeURIComponent(key.id)}`, { method: "DELETE" }));
    if (done) showToast(`« ${key.label} » est révoquée.`);
  }
}

async function handleAssistantKeySubmit(event) {
  const formElement = event.target.closest("[data-assistant-form]");
  if (!formElement) return;
  event.preventDefault();
  const ui = assistantUi();
  const data = new FormData(formElement);
  const presetIds = data.get("presetMode") === "all" ? [] : data.getAll("preset").map(String);
  const errorBox = formElement.querySelector(".assistant-key-error");
  if (data.get("presetMode") === "some" && !presetIds.length) {
    errorBox.textContent = "Coche au moins un preset, ou choisis « Tous mes presets ».";
    errorBox.hidden = false;
    return;
  }
  const payload = {
    label: String(data.get("label") || "").trim(),
    rpm: Number(data.get("rpm")),
    maxConcurrent: Number(data.get("maxConcurrent")),
    dailyLimit: Number(data.get("dailyLimit")),
    presetIds,
  };
  const submit = formElement.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    if (formElement.dataset.assistantForm) {
      await api(`/api/studio/api-keys/${encodeURIComponent(formElement.dataset.assistantForm)}`, { method: "PATCH", body: payload });
      showToast("Clé mise à jour.");
    } else {
      const created = await api("/api/studio/api-keys", { method: "POST", body: payload });
      // le clair n'existe qu'ici : il est posé dans l'état avant toute relecture de la liste, qui peut échouer
      ui.reveal = { id: created.id, label: created.label, key: created.key };
    }
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
    submit.disabled = false;
    return;
  }
  ui.form = null;
  await loadAssistantKeys();
  renderAssistantKeys();
}

function renderApiKeysPage() {
  const container = document.getElementById("apikeys-list");
  if (!container || !state.config) return;
  const engine = state.config.engine || {};
  if (!state.engineProfiles) {
    // première ouverture : on affiche tout de suite, puis on remplace la carte moteur quand le
    // catalogue arrive — sauf si une clé est déjà en cours de saisie
    loadEngineProfiles().then(() => {
      const saisie = [...document.querySelectorAll("#apikeys-list .api-key-input")].some((input) => input.value);
      if (!saisie) renderApiKeysPage();
    });
  }
  const keys = [
    ...(engineKeyEntries() || [
      { id: "engine", label: "Moteur IA (DeepSeek)", endpoint: "/api/studio/engine-key", configured: engine.apiKeyConfigured, placeholder: "sk-...", help: "Clé principale pour la génération de réponses IA." },
    ]),
    { id: "vision",   label: "OpenAI Vision + Whisper",   endpoint: "/api/studio/vision-key", configured: engine.visionApiKeyConfigured,  placeholder: "sk-proj-...",   help: "Analyse des snaps (vision) et transcription vocale (Whisper)." },
    { id: "fallback", label: "Anthropic (Haiku secours)", endpoint: "/api/studio/haiku-key",  configured: engine.fallbackKeyConfigured,   placeholder: "sk-ant-...",    help: "Modèle de secours si le moteur principal tombe." },
  ];
  // Le serveur normalise a la LECTURE, donc la section arrive toujours remplie.
  // La garde couvre le cas ou elle manquerait quand meme: `setAtPath` ecrit dans
  // l'objet parent et jetterait sur un parent absent, ce qui casserait la page
  // entiere au premier clic — pas seulement ce champ.
  const rawAbbrev = state.config.abbreviations;
  const group = (value) => ({
    fr: Array.isArray(value?.fr) ? value.fr : [],
    en: Array.isArray(value?.en) ? value.en : [],
  });
  const abbreviations = {
    enabled: rawAbbrev?.enabled !== false,
    suggested: group(rawAbbrev?.suggested),
    replaced: group(rawAbbrev?.replaced),
  };
  state.config.abbreviations = abbreviations;

  container.innerHTML = keys.map(k => `
    <div class="api-key-card" data-key-id="${k.id}">
      <div class="api-key-header">
        <span class="api-key-status ${k.configured ? "configured" : "missing"}"></span>
        <div class="api-key-label">
          <strong>${k.label}</strong>
          <span class="api-key-badge ${k.configured ? "configured" : "missing"}">${k.configured ? "Configurée" : "Non configurée"}</span>
        </div>
      </div>
      <p class="api-key-help">${k.help}</p>
      <div class="api-key-input-row">
        <input type="password" class="api-key-input" data-key-id="${k.id}" data-endpoint="${k.endpoint}" ${k.profileId ? `data-profile-id="${escapeHtml(k.profileId)}"` : ""} placeholder="${k.configured ? "Coller une nouvelle clé pour remplacer" : k.placeholder}">
        <button type="button" class="button secondary api-key-save" data-key-id="${k.id}" disabled>Enregistrer</button>
      </div>
    </div>
  `).join("") + `
    <div class="api-key-card" id="abbreviations-card">
      <div class="api-key-header">
        <div class="api-key-label"><strong>Abréviations générales</strong></div>
      </div>
      <p class="api-key-help">Vocabulaire d'écriture commun à <strong>tous les presets et toutes les plateformes</strong> — une orthographe parfaite est en soi un signe. Une ligne au format <code>abréviation = signification</code>, le même que la liste par preset, qui reste prioritaire en cas de doublon.</p>
      ${toggle("Activer les abréviations", "abbreviations.enabled", abbreviations.enabled, "config")}

      <h4>Suggérées</h4>
      <p class="api-key-help">Partent dans le prompt comme vocabulaire autorisé. Le modèle les emploie <strong>quand ça tombe bien</strong>, donc irrégulièrement — c'est le but : abréger à tous les coups est un motif aussi net que ne jamais abréger. Cette liste peut être large sans risque.</p>
      <div class="field">
        <label>Français (${abbreviations.suggested.fr.length})</label>
        <textarea data-config-path="abbreviations.suggested.fr" data-list="lines" rows="9" placeholder="jsp = je sais pas&#10;tkt = t'inquiete">${escapeHtml(abbreviations.suggested.fr.join("\n"))}</textarea>
      </div>
      <div class="field">
        <label>Anglais (${abbreviations.suggested.en.length})</label>
        <textarea data-config-path="abbreviations.suggested.en" data-list="lines" rows="9" placeholder="idk = I don't know&#10;tbh = to be honest">${escapeHtml(abbreviations.suggested.en.join("\n"))}</textarea>
      </div>

      <h4>Substituées</h4>
      <p class="api-key-help">Remplacées <strong>mécaniquement</strong> dans la réponse produite, au plus une par message. La substitution ne regarde pas le contexte : n'y mettre que des expressions <strong>assez longues</strong> pour être sans ambiguïté. « beaucoup » → « bcp » est sûr ; « non » → « nn » ou « tout » → « tt » se déclenchent à tort et ça se voit.</p>
      <div class="field">
        <label>Français (${abbreviations.replaced.fr.length})</label>
        <textarea data-config-path="abbreviations.replaced.fr" data-list="lines" rows="7" placeholder="jsp = je sais pas&#10;pcq = parce que">${escapeHtml(abbreviations.replaced.fr.join("\n"))}</textarea>
      </div>
      <div class="field">
        <label>Anglais (${abbreviations.replaced.en.length})</label>
        <textarea data-config-path="abbreviations.replaced.en" data-list="lines" rows="7" placeholder="idk = I don't know&#10;btw = by the way">${escapeHtml(abbreviations.replaced.en.join("\n"))}</textarea>
        <p class="api-key-help">Les listes anglaises ne servent qu'aux presets réglés en anglais ; « Auto » reste sur le français, faute de savoir à l'avance dans quelle langue arrivera le message. La <strong>compréhension</strong> des abréviations reçues couvre les deux listes réunies, toujours — comprendre n'engage à rien, ignorer rend sourd.</p>
      </div>
      <div class="api-key-input-row">
        <button type="button" class="button" id="abbreviations-save">Enregistrer les abréviations</button>
        <span class="api-key-help" id="abbreviations-status"></span>
      </div>
    </div>
  `;

  // Cette page masque le bouton « Enregistrer » global (setView), parce que
  // chaque carte de cle s'enregistre elle-meme. Une section liee a la config y
  // serait donc impossible a sauvegarder: elle a son propre bouton.
  bindConfigControls(container);
  const saveButton = container.querySelector("#abbreviations-save");
  const saveStatus = container.querySelector("#abbreviations-status");
  saveButton?.addEventListener("click", async () => {
    saveButton.disabled = true;
    saveButton.textContent = "Enregistrement...";
    try {
      state.config = await api("/api/studio/config", { method: "PUT", body: state.config });
      markSaved();
      showToast("Abréviations enregistrées.");
      // Re-rendu pour afficher les valeurs telles que le serveur les a
      // normalisees (trim, doublons retires): sans ca l'ecran montre ce qui a
      // ete tape, pas ce qui a ete garde.
      renderApiKeysPage();
    } catch (error) {
      if (saveStatus) saveStatus.textContent = error.message;
      showToast(error.message, "error");
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = "Enregistrer les abréviations";
    }
  });
  for (const input of container.querySelectorAll(".api-key-input")) {
    const btn = container.querySelector(`.api-key-save[data-key-id="${input.dataset.keyId}"]`);
    input.addEventListener("input", () => { btn.disabled = !input.value.trim(); });
  }
  for (const btn of container.querySelectorAll(".api-key-save")) {
    btn.addEventListener("click", async () => {
      const kid = btn.dataset.keyId;
      const input = container.querySelector(`.api-key-input[data-key-id="${kid}"]`);
      const key = input.value.trim();
      if (!key) return;
      btn.disabled = true;
      btn.textContent = "...";
      try {
        const endpoint = input.dataset.endpoint;
        const profileId = input.dataset.profileId;
        await api(endpoint, { method: "PUT", body: profileId ? { id: profileId, key } : { key } });
        input.value = "";
        if (profileId) {
          // le sélecteur « Moteur actif » ne doit plus réclamer cette clé ; le moteur en cours la relit à chaque appel
          if (engineKeyEntries()?.find((entry) => entry.id === kid)?.active) state.config.engine.apiKeyConfigured = true;
          await loadEngineProfiles();
        }
        input.placeholder = "Coller une nouvelle clé pour remplacer";
        const dot = container.querySelector(`.api-key-card[data-key-id="${kid}"] .api-key-status`);
        if (dot) { dot.classList.remove("missing"); dot.classList.add("configured"); }
        const badge = container.querySelector(`.api-key-card[data-key-id="${kid}"] .api-key-badge`);
        if (badge) { badge.classList.remove("missing"); badge.classList.add("configured"); badge.textContent = "Configurée"; }
        btn.textContent = "OK !";
        setTimeout(() => { btn.textContent = "Enregistrer"; }, 1500);
      } catch (e) {
        showToast(e.message, "error");
        btn.textContent = "Erreur";
        setTimeout(() => { btn.textContent = "Enregistrer"; btn.disabled = false; }, 2000);
      }
    });
  }
}

function renderAccounts() {
  if (!state.config) return;
  // Les reglages de comptes ChatNow ont ete retires du dashboard: il ne reste
  // sur cette page que les parametres du moteur.

  const engine = state.config.engine;
  const isOllama = engine.provider === "ollama";
  elements.engineSettings.innerHTML = `
    <div class="field engine-profile-field">
      <label for="engine-profile">Moteur actif</label>
      <select id="engine-profile">${engineProfileOptionsHtml()}</select>
      <p class="field-help" id="engine-profile-note">${escapeHtml(engineProfileNote())}</p>
    </div>
    <div class="field">
      <label>Fournisseur</label>
      <select data-config-path="engine.provider">
        <option value="capitalai" ${engine.provider === "capitalai" ? "selected" : ""}>CapitalAI</option>
        <option value="deepseek" ${engine.provider === "deepseek" ? "selected" : ""}>DeepSeek</option>
        <option value="ollama" ${isOllama ? "selected" : ""}>Ollama (local ou distant)</option>
        <option value="bambou-remote" ${engine.provider === "bambou-remote" ? "selected" : ""}>BambouAI sur le PC IA</option>
        <option value="bambou-local" ${engine.provider === "bambou-local" ? "selected" : ""}>BambouAI local</option>
        <option value="openai" ${engine.provider === "openai" ? "selected" : ""}>OpenAI compatible</option>
      </select>
    </div>
    <div class="field">
      <label>URL du moteur</label>
      <input data-config-path="engine.baseUrl" value="${escapeHtml(engine.baseUrl || "")}" placeholder="${isOllama ? "http://127.0.0.1:11434" : engine.provider === "deepseek" ? "https://api.deepseek.com" : "https://ai.bambouaibot.com"}">
      ${isOllama ? '<p class="field-help">Adresse accessible depuis le serveur du site. 127.0.0.1 désigne cette machine ; pour un autre PC, indique son adresse réseau.</p>' : ""}
    </div>
    <div class="field">
      <label>Modèle</label>
      <input data-config-path="engine.model" value="${escapeHtml(engine.model)}" ${isOllama ? 'list="ollama-model-options"' : ""} placeholder="${isOllama ? "Nom exact du modèle installé" : "Nom ou identifiant du modèle"}">
      ${isOllama ? '<datalist id="ollama-model-options"></datalist><button id="load-ollama-models" type="button" class="button secondary">Charger les modèles Ollama</button><span id="ollama-models-result" class="field-help" role="status"></span>' : ""}
    </div>
    <div class="field">
      <label>Température</label>
      <input type="number" min="0" max="2" step="0.1" data-config-path="engine.temperature" value="${escapeHtml(engine.temperature)}">
    </div>
    <div class="field">
      <label>Tokens maximum</label>
      <input type="number" min="20" max="2000" data-config-path="engine.maxTokens" value="${escapeHtml(engine.maxTokens)}">
    </div>
    <div class="field">
      <label>Générations parallèles</label>
      <input type="number" min="1" max="20" data-config-path="engine.parallelGenerations" value="${escapeHtml(engine.parallelGenerations)}">
    </div>
    <div class="field">
      <label>Délai maximum (secondes)</label>
      <input type="number" min="5" max="600" data-config-path="engine.requestTimeoutSeconds" value="${escapeHtml(engine.requestTimeoutSeconds || 120)}">
    </div>
    <div class="field">
      <label>${isOllama ? "Clé Ollama (facultative)" : "Clé privée du moteur"}</label>
      <input id="${isOllama ? "ollama-api-key" : "engine-api-key"}" type="password" value="${isOllama ? escapeHtml(state.ollamaKeyDraft ?? "") : ""}" placeholder="${(isOllama ? engine.ollamaKeyConfigured : engine.apiKeyConfigured) ? "Clé déjà configurée" : isOllama ? "Aucune clé nécessaire en local" : "Configurer la clé privée"}">
      <p class="field-help">${isOllama ? "Réservée à un serveur protégé par un jeton Bearer. Stockée séparément des clés des autres fournisseurs." : "La clé du moteur actif est stockée séparément, par fournisseur, et n’est jamais renvoyée au navigateur."}</p>
      ${isOllama ? '<button id="clear-ollama-key" type="button" class="button secondary">Utiliser sans clé</button>' : ""}
    </div>
    <div class="field">
      <label>Modèle de secours (Haiku / Anthropic)</label>
      <input data-config-path="engine.fallbackModel" value="${escapeHtml(engine.fallbackModel || "claude-haiku-4-5-20251001")}" placeholder="claude-haiku-4-5-20251001">
      <p class="field-help">Si une clé de secours est configurée, une panne temporaire du moteur principal peut basculer vers Anthropic.</p>
    </div>
    <div class="field">
      <label>Clé API du moteur de secours</label>
      <input id="fallback-api-key" type="password" value="" placeholder="${engine.fallbackKeyConfigured ? "Clé déjà configurée" : "Clé Anthropic (Haiku)"}">
      <p class="field-help">Stockée séparément, jamais renvoyée au navigateur.</p>
    </div>
    <div class="field">
      <label>Recheck du principal (minutes)</label>
      <input type="number" min="1" max="120" data-config-path="engine.recheckIntervalMinutes" value="${escapeHtml(engine.recheckIntervalMinutes || 10)}">
      <p class="field-help">En bascule sur le secours, re-teste le principal tous les X min et y repasse dès qu'il répond.</p>
    </div>
    <div class="field">
      <label>Analyse images OpenAI</label>
      ${toggle("Activer pour les moteurs texte", "engine.visionEnabled", engine.visionEnabled !== false, "config")}
      <p class="field-help">OpenAI résume les photos utilisateur, puis le moteur texte reçoit le résumé.</p>
    </div>
    <div class="field">
      <label>URL OpenAI Vision</label>
      <input data-config-path="engine.visionBaseUrl" value="${escapeHtml(engine.visionBaseUrl || "https://api.openai.com/v1")}" placeholder="https://api.openai.com/v1">
    </div>
    <div class="field">
      <label>Modele Vision</label>
      <input data-config-path="engine.visionModel" value="${escapeHtml(engine.visionModel || "gpt-4o-mini")}" placeholder="gpt-4o-mini">
    </div>
    <div class="field">
      <label>Detail Vision</label>
      <select data-config-path="engine.visionDetail">
        <option value="low" ${(engine.visionDetail || "low") === "low" ? "selected" : ""}>Low - moins cher</option>
        <option value="auto" ${["auto", "medium"].includes(engine.visionDetail) ? "selected" : ""}>Auto - equilibre</option>
        <option value="high" ${engine.visionDetail === "high" ? "selected" : ""}>High - plus precis</option>
      </select>
      <p class="field-help">Auto laisse OpenAI choisir le bon niveau selon l'image.</p>
    </div>
    <div class="field">
      <label>Cle OpenAI Vision</label>
      <input id="vision-api-key" type="password" value="" placeholder="${engine.visionApiKeyConfigured ? "Cle deja configuree" : "sk-..."}">
      <p class="field-help">Utilisee seulement pour resumer les images.</p>
    </div>
    <div class="field engine-test-field">
      <label>Connexion</label>
      <button id="test-engine" type="button" class="button secondary">Tester le moteur</button>
      <span id="engine-test-result" class="field-help"></span>
    </div>
  `;
  bindConfigControls(document.querySelector("#view-accounts"));
  document.querySelector("#engine-profile")?.addEventListener("change", (event) => {
    switchEngineProfile(event.target.value);
  });
  if (!state.engineProfiles) loadEngineProfiles();
  document.querySelector("#engine-api-key")?.addEventListener("input", (event) => {
    state.engineKeyDraft = event.target.value;
    markDirty();
  });
  document.querySelector("#vision-api-key")?.addEventListener("input", (event) => {
    state.visionKeyDraft = event.target.value;
    markDirty();
  });
  document.querySelector("#fallback-api-key")?.addEventListener("input", (event) => {
    state.fallbackKeyDraft = event.target.value;
    markDirty();
  });
  document.querySelector("#test-engine")?.addEventListener("click", testEngine);
  document.querySelector("#load-ollama-models")?.addEventListener("click", loadOllamaModels);
  document.querySelector("#ollama-api-key")?.addEventListener("input", (event) => {
    state.ollamaKeyDraft = event.target.value;
    markDirty();
  });
  document.querySelector("#clear-ollama-key")?.addEventListener("click", () => {
    state.ollamaKeyDraft = "";
    document.querySelector("#ollama-api-key").value = "";
    markDirty();
    showToast("Le mode sans clé sera appliqué à l'enregistrement.");
  });
}

// --- Moteur actif : choix d'un profil du catalogue serveur (data/engine-profiles.json) ---
function activeEngineProfile() {
  const engine = state.config?.engine || {};
  const normalize = (url) => String(url || "").trim().replace(/\/+$/, "").toLowerCase();
  return (state.engineProfiles?.profiles || []).find((profile) =>
    normalize(profile.baseUrl) === normalize(engine.baseUrl)
    && profile.model === String(engine.model || "").trim(),
  ) || null;
}

function engineProfileOptionsHtml() {
  const profiles = state.engineProfiles?.profiles || [];
  const active = activeEngineProfile();
  return [
    ...profiles.map((profile) => `
      <option value="${escapeHtml(profile.id)}" ${active?.id === profile.id ? "selected" : ""}>
        ${escapeHtml(profile.label)}${profile.keyConfigured ? "" : " — clé à saisir"}
      </option>`),
    ...(active ? [] : ['<option value="" selected>Personnalisé (réglages ci-dessous)</option>']),
  ].join("");
}

function engineProfileNote() {
  if (!state.engineProfiles) return "Chargement des moteurs…";
  if (state.engineProfiles.error) return `Liste des moteurs indisponible : ${state.engineProfiles.error}`;
  const active = activeEngineProfile();
  if (active) return [active.note, active.warning ? `⚠ ${active.warning}` : ""].filter(Boolean).join(" ");
  return "Réglages manuels : ce moteur ne correspond à aucun profil du catalogue.";
}

function syncEngineProfileSelect() {
  const select = document.querySelector("#engine-profile");
  if (!select) return;
  select.innerHTML = engineProfileOptionsHtml();
  const note = document.querySelector("#engine-profile-note");
  if (note) note.textContent = engineProfileNote();
}

async function loadEngineProfiles() {
  try {
    state.engineProfiles = await api("/api/studio/engine-profiles");
  } catch (error) {
    // on garde la liste déjà connue ; sinon on dit la vraie raison au lieu d'un faux « personnalisé »
    state.engineProfiles = state.engineProfiles?.profiles?.length
      ? state.engineProfiles
      : { activeId: null, profiles: [], error: error.message };
    showToast(`Liste des moteurs indisponible : ${error.message}`, "error");
  }
  syncEngineProfileSelect();
}

async function switchEngineProfile(id) {
  const profile = (state.engineProfiles?.profiles || []).find((candidate) => candidate.id === id);
  if (!profile || profile.id === activeEngineProfile()?.id) {
    syncEngineProfileSelect();
    return;
  }
  // Le changement s'applique tout de suite à toute la flotte : on confirme toujours.
  const question = [
    `Basculer les réponses de tous les comptes sur « ${profile.label} » ?`,
    profile.warning ? `\n⚠ ${profile.warning}` : "",
    state.dirty ? "\nLes modifications non enregistrées de cette page seront perdues." : "",
  ].join("");
  if (!confirm(question)) {
    syncEngineProfileSelect();
    return;
  }
  const select = document.querySelector("#engine-profile");
  if (select) select.disabled = true;
  let switched = false;
  try {
    if (!profile.keyConfigured) {
      const key = window.prompt(`Clé API pour « ${profile.label} » (gardée sur le serveur, jamais renvoyée au navigateur) :`);
      if (!key || !key.trim()) return;
      await api("/api/studio/engine-profile-key", { method: "PUT", body: { id: profile.id, key: key.trim() } });
    }
    // Le serveur teste le moteur visé avant de l'activer : en cas de refus il garde l'actuel.
    state.config = await api("/api/studio/engine-profile", { method: "PUT", body: { id: profile.id } });
    // la config vient d'être rechargée du serveur : une clé tapée mais pas enregistrée visait l'ancien moteur
    state.engineKeyDraft = "";
    const brouillonsEnAttente = Boolean(state.visionKeyDraft || state.fallbackKeyDraft || state.ollamaKeyDraft !== null);
    if (!brouillonsEnAttente) markSaved();
    switched = true;
    showToast(`Moteur actif : ${profile.label}`);
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    await loadEngineProfiles();
    if (switched) {
      renderAccounts();
      const result = document.querySelector("#engine-test-result");
      if (result) result.textContent = `Connecté · ${profile.model}`;
    }
    const current = document.querySelector("#engine-profile");
    if (current) current.disabled = false;
  }
}

function bindConfigControls(container) {
  for (const input of container.querySelectorAll("[data-config-path]")) {
    input.addEventListener("change", () => {
      const previousProvider = state.config.engine?.provider;
      setAtPath(state.config, input.dataset.configPath, inputValue(input));
      if (input.dataset.configPath === "engine.provider") applyEngineProviderDefaults(input.value, previousProvider);
      if (/^engine\.(provider|baseUrl|model)$/.test(input.dataset.configPath)) syncEngineProfileSelect();
      markDirty();
    });
  }
}

function bindChatNowAccountActions(container) {
  if (!container) return;
  for (const button of container.querySelectorAll(".account-session-export")) {
    button.addEventListener("click", () => exportChatNowAccountSession(button));
  }
  for (const button of container.querySelectorAll(".account-email-register")) {
    button.addEventListener("click", () => exportChatNowAccountSession(button, { registerEmail: true }));
  }
  for (const button of container.querySelectorAll(".account-delete")) {
    button.addEventListener("click", () => deleteChatNowAccount(button));
  }
}

async function deleteChatNowAccount(button) {
  const accountId = button.dataset.accountId;
  const account = state.config?.accounts?.[Number(button.dataset.accountIndex)];
  if (!accountId || !account) return;
  const label = account.name || account.id || accountId;
  if (!window.confirm(`Supprimer le compte ChatNow ${label} ?`)) return;

  const previousText = button.textContent;
  button.disabled = true;
  button.textContent = "Suppression...";
  try {
    if (state.dirty) {
      await saveStudio();
      if (state.dirty) throw new Error("Sauvegarde Studio interrompue, suppression annulee.");
    }
    const payload = await api(`/api/accounts/${encodeURIComponent(accountId)}`, {
      method: "DELETE",
    });
    await applyPayloadConfig(payload);
    if (Array.isArray(payload.mailboxes)) state.mailboxes = payload.mailboxes;
    if (state.selectedAccountId === accountId) state.selectedAccountId = null;
    markSaved();
    if (state.dashboard) {
      await loadDashboard({ quiet: true });
    } else {
      renderChatNowAccountSettings();
      renderAccounts();
    }
    showToast(`Compte ${label} supprime.`);
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = previousText;
  }
}

async function exportChatNowAccountSession(button, options = {}) {
  const accountId = button.dataset.accountId;
  const account = state.config?.accounts?.[Number(button.dataset.accountIndex)];
  if (!accountId || !account) return;
  const liveAccount = state.dashboard?.accounts?.find((entry) => entry.id === accountId);
  const replaceDiscarded = Boolean(account.discardedAt || liveAccount?.discarded || liveAccount?.banned);

  const previousText = button.textContent;
  button.disabled = true;
  button.textContent = options.registerEmail
    ? "Inscription..."
    : String(account.profileId || "").trim() ? "Export..." : "Creation...";
  try {
    if (state.dirty) await saveStudio();
    const payload = await api(`/api/accounts/${encodeURIComponent(accountId)}/session/export`, {
      method: "POST",
      body: {
        profileId: account.profileId,
        port: account.port,
        createAdspowerProfile: !String(account.profileId || "").trim(),
        registerEmail: Boolean(options.registerEmail),
        replaceDiscarded,
      },
    });
    await applyPayloadConfig(payload);
    markSaved();
    if (state.dashboard) {
      await loadDashboard({ quiet: true });
    } else {
      renderChatNowAccountSettings();
    }

    if (payload.registration?.confirmed) {
      showToast(`Inscription e-mail confirmee et session exportee pour ${payload.assignment?.name || account.name}.`);
    } else if (payload.registration?.attempted && !payload.registration?.confirmed) {
      showToast(payload.registration.reason || "Inscription e-mail non terminee.", "error");
    } else if (payload.worker?.started) {
      showToast(`Session exportee et worker ${payload.assignment?.name || account.name} lance.`);
    } else if (payload.adspowerProfile?.created) {
      showToast(`Profil AdsPower cree: ${payload.profileId}. Connecte-le a ChatNow puis clique Exporter session.`, "error");
    } else if (payload.sessionExport?.ok) {
      showToast(`Session exportee, mais worker non lance: ${payload.worker?.reason || "verifie le profil"}.`, "error");
    } else {
      showToast(payload.sessionExport?.reason || "Export AdsPower echoue.", "error");
    }
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = previousText || "Exporter session";
  }
}

function applyEngineProviderDefaults(provider, previousProvider) {
  const engine = state.config.engine;
  engine.providerSettings ||= {};
  if (previousProvider && previousProvider !== provider) {
    engine.providerSettings[previousProvider] = { baseUrl: engine.baseUrl, model: engine.model };
  }
  const saved = engine.providerSettings[provider];
  if (saved) {
    engine.baseUrl = saved.baseUrl;
    engine.model = saved.model;
  } else if (provider === "ollama" || previousProvider === "ollama") {
    engine.baseUrl = "";
    engine.model = "";
  }
  const knownBaseUrls = [
    "",
    "https://api.deepseek.com",
    "https://api.openai.com/v1",
    "https://ai.bambouaibot.com",
  ];
  const knownModels = [
    "",
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "gpt-4.1-mini",
    "Qwen/Qwen2.5-3B-Instruct",
    "Qwen/Qwen2.5-7B-Instruct",
  ];
  if (!saved && provider === "deepseek") {
    if (knownBaseUrls.includes(String(engine.baseUrl || ""))) engine.baseUrl = "https://api.deepseek.com";
    if (knownModels.includes(String(engine.model || ""))) engine.model = "deepseek-v4-flash";
    engine.maxTokens = Number(engine.maxTokens || 80);
    engine.requestTimeoutSeconds = Number(engine.requestTimeoutSeconds || 60);
  }
  if (!saved && provider === "openai") {
    if (knownBaseUrls.includes(String(engine.baseUrl || ""))) engine.baseUrl = "https://api.openai.com/v1";
    if (knownModels.includes(String(engine.model || ""))) engine.model = "gpt-4.1-mini";
  }
  if (provider === "ollama") {
    engine.baseUrl ||= "http://127.0.0.1:11434";
  }
  engine.visionEnabled = engine.visionEnabled !== false;
  engine.visionBaseUrl = engine.visionBaseUrl || "https://api.openai.com/v1";
  engine.visionModel = engine.visionModel || "gpt-4o-mini";
  engine.visionDetail = engine.visionDetail || "low";
  renderAccounts();
}

async function syncAccountCities() {
  const button = document.querySelector("#sync-account-cities");
  if (button) {
    button.disabled = true;
    button.textContent = "Synchronisation...";
  }
  try {
    const payload = await api("/api/dashboard");
    const citiesByAccount = new Map(
      (payload.accounts || [])
        .filter((account) => account.id && account.city)
        .map((account) => [account.id, account.city]),
    );
    let updated = 0;
    for (const account of state.config.accounts) {
      const city = citiesByAccount.get(account.id);
      if (city && account.city !== city) {
        account.city = city;
        updated += 1;
      }
    }
    if (updated) {
      markDirty();
      renderAccounts();
      showToast(`${updated} ville(s) synchronisee(s).`);
    } else {
      showToast("Aucune nouvelle ville trouvee.");
    }
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    const nextButton = document.querySelector("#sync-account-cities");
    if (nextButton) {
      nextButton.disabled = false;
      nextButton.textContent = "Synchroniser villes ChatNow";
    }
  }
}

function ensurePlaygroundLayout() {
  const view = document.querySelector("#view-playground");
  if (!view || view.querySelector(".playground-capital-shell")) return;

  view.innerHTML = `
    <div class="playground-page-head">
      <div>
        <h2>Playground</h2>
        <p>Test and experiment with the AI engine</p>
      </div>
      <div class="playground-head-actions">
        <span class="nsfw-pill">NSFW</span>
        <button id="reset-playground" type="button" class="button secondary">Reset</button>
      </div>
    </div>

    <div class="playground-capital-shell">
      <section class="playground-chat-panel">
        <div class="playground-topbar">
          <div class="playground-select-field">
            <label for="playground-model">Model:</label>
            <select id="playground-model"></select>
          </div>
          <div class="playground-select-field">
            <label for="playground-preset">Preset:</label>
            <select id="playground-preset"></select>
          </div>
          <div id="playground-engine-status" class="engine-indicator">
            <span aria-hidden="true"></span>
            Moteur non teste
          </div>
        </div>

        <div id="playground-messages" class="playground-messages">
          <div class="playground-empty">Start chatting to test your AI configuration...</div>
        </div>

        <div class="playground-opener-hint">Send an empty message to test openers</div>

        <form id="playground-form" class="playground-input-bar">
          <label class="playground-tool-button" title="Attachment" aria-label="Attachment">
            A
            <input id="playground-image-input" type="file" accept="image/png,image/jpeg,image/webp" hidden>
          </label>
          <button type="button" class="playground-tool-button" title="Voice" aria-label="Voice">V</button>
          <label class="sr-only" for="playground-input">Message de test</label>
          <textarea id="playground-input" rows="1" placeholder="Type a message..."></textarea>
          <button type="submit" class="playground-send-button" aria-label="Envoyer">S</button>
        </form>
      </section>

      <aside class="playground-debug-panel">
        <div class="debug-tabs">
          <button type="button" class="debug-tab active" data-playground-debug="request">Request</button>
          <button type="button" class="debug-tab" data-playground-debug="response">Response</button>
        </div>
        <pre id="playground-request" class="debug-code"></pre>
        <pre id="playground-response" class="debug-code" hidden></pre>
      </aside>
    </div>
  `;

  elements.playgroundPreset = document.querySelector("#playground-preset");
  elements.playgroundModel = document.querySelector("#playground-model");
  elements.playgroundEngineStatus = document.querySelector("#playground-engine-status");
  elements.playgroundMessages = document.querySelector("#playground-messages");
  elements.playgroundForm = document.querySelector("#playground-form");
  elements.playgroundInput = document.querySelector("#playground-input");
  elements.playgroundImageInput = document.querySelector("#playground-image-input");
  elements.resetPlayground = document.querySelector("#reset-playground");
  elements.playgroundRequest = document.querySelector("#playground-request");
  elements.playgroundResponse = document.querySelector("#playground-response");
}

function currentPlaygroundPreset() {
  const presets = configPresets();
  return presets.find((preset) => preset.id === elements.playgroundPreset?.value)
    || currentPreset()
    || presets[0];
}

function currentPlaygroundMediaVault() {
  return state.mediaLibrary?.vaults.find((vault) => vault.id === state.playgroundMediaVaultId) || null;
}

function nowTimestampSeconds() {
  return Math.floor(Date.now() / 1000);
}

function playgroundMessageTimestamp(message, index) {
  const timestamp = Number(message?.timestamp);
  return Number.isFinite(timestamp)
    ? timestamp
    : nowTimestampSeconds() - Math.max(0, state.playgroundMessages.length - index) * 3;
}

function capitalPlaygroundRole(role) {
  return role === "assistant" ? "bot" : "user";
}

function playgroundDebugHistoryItem(message, index) {
  const isImage = message.type === "image";
  const item = {
    role: capitalPlaygroundRole(message.role),
    content: isImage ? "[image attached]" : message.content,
    timestamp: playgroundMessageTimestamp(message, index),
  };
  if (message.type) item.type = message.type;
  if (isImage) item.imageUrl = String(message.content || "").startsWith("data:image/")
    ? "[data:image]"
    : message.content;
  if (message.itemId) item.itemId = message.itemId;
  if (message.mediaPool) item.mediaPool = message.mediaPool;
  if (typeof message.disappearing === "boolean") item.disappearing = message.disappearing;
  if (Number.isFinite(Number(message.delayMs))) item.delayMs = Number(message.delayMs);
  return item;
}

function buildPlaygroundDebugRequest() {
  const preset = currentPlaygroundPreset();
  const vault = currentPlaygroundMediaVault();
  const account = state.config?.accounts.find((item) => item.presetId === preset?.id);
  const accountCity = String(account?.city || "").trim();
  const useAccountCity = preset?.mainSettings?.useAccountLocation !== false && accountCity;
  return {
    licensekey: state.config?.engine?.apiKeyConfigured ? "[configured]" : "[missing]",
    modelId: vault?.name || "No Media Vault",
    mediaVaultId: vault?.id || "",
    presetId: preset?.id || "preset",
    accountId: account?.id || "playground",
    userInfos: {
      useridentifier: "961155202995",
      name: "John Smith",
    },
    platform: "Playground",
    stopped: Boolean(state.playgroundStopped),
    stopReason: state.playgroundStopReason || null,
    city: useAccountCity ? accountCity : preset?.identity?.city || "",
    citySource: useAccountCity ? "account" : "preset",
    vision: {
      enabled: state.config?.engine?.visionEnabled !== false,
      model: state.config?.engine?.visionModel || "gpt-4o-mini",
      detail: state.config?.engine?.visionDetail || "low",
      key: state.config?.engine?.visionApiKeyConfigured ? "[configured]" : "[missing]",
    },
    chatHistory: state.playgroundMessages.map(playgroundDebugHistoryItem),
  };
}

function highlightedJson(value) {
  const json = JSON.stringify(value, null, 2);
  const tokenPattern = /"(?:\\.|[^"\\])*"|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?/g;
  let html = "";
  let lastIndex = 0;

  for (const match of json.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index || 0;
    html += escapeHtml(json.slice(lastIndex, index));

    let type = "number";
    if (token.startsWith("\"")) {
      type = /^\s*:/.test(json.slice(index + token.length)) ? "key" : "string";
    } else if (token === "true" || token === "false") {
      type = "boolean";
    } else if (token === "null") {
      type = "null";
    }

    html += `<span class="json-${type}">${escapeHtml(token)}</span>`;
    lastIndex = index + token.length;
  }

  return html + escapeHtml(json.slice(lastIndex));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function fallbackPlaygroundDelayMs(item) {
  if (item?.type === "image") return 900;
  const text = String(item?.content || "").trim();
  if (!text) return 500;
  if (/^https?:\/\/\S+$/i.test(text)) return 650;
  const chars = Array.from(text).length;
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(650, Math.min(4200, Math.round(500 + chars * 28 + words * 65)));
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")));
    reader.addEventListener("error", () => reject(new Error("Image illisible.")));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image));
    image.addEventListener("error", () => reject(new Error("Image invalide.")));
    image.src = src;
  });
}

async function compressPlaygroundImage(file) {
  if (!file || !/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
    throw new Error("Choisis une image PNG, JPG ou WebP.");
  }
  const dataUrl = await readFileAsDataUrl(file);
  const image = await loadImageElement(dataUrl);
  const maxSide = 768;
  const scale = Math.min(1, maxSide / Math.max(image.width || 1, image.height || 1));
  const width = Math.max(1, Math.round((image.width || 1) * scale));
  const height = Math.max(1, Math.round((image.height || 1) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", 0.74);
}

function renderPlaygroundDebug() {
  if (!elements.playgroundRequest || !elements.playgroundResponse) return;
  const request = state.playgroundLastRequest || buildPlaygroundDebugRequest();
  const response = state.playgroundLastResponse || {
    status: "Waiting for a generated response",
  };
  elements.playgroundRequest.innerHTML = highlightedJson(request);
  elements.playgroundResponse.innerHTML = highlightedJson(response);
  const showRequest = state.playgroundDebugTab !== "response";
  elements.playgroundRequest.hidden = !showRequest;
  elements.playgroundResponse.hidden = showRequest;
  for (const tab of document.querySelectorAll("[data-playground-debug]")) {
    tab.classList.toggle("active", tab.dataset.playgroundDebug === state.playgroundDebugTab);
  }
}

function renderPlayground() {
  ensurePlaygroundLayout();
  if (!state.config) return;
  const presets = configPresets();
  const selected = elements.playgroundPreset.value || state.selectedPresetId;
  const vaults = state.mediaLibrary?.vaults || [];
  if (state.playgroundMediaVaultId && !vaults.some((vault) => vault.id === state.playgroundMediaVaultId)) {
    state.playgroundMediaVaultId = "";
  }
  elements.playgroundPreset.innerHTML = presetOptionsHtml(presets, selected);
  elements.playgroundModel.innerHTML = [
    `<option value="" ${state.playgroundMediaVaultId ? "" : "selected"}>Aucun Media Vault</option>`,
    ...vaults.map((vault) => `
    <option value="${escapeHtml(vault.id)}" ${vault.id === state.playgroundMediaVaultId ? "selected" : ""}>
      ${escapeHtml(vault.name)}
    </option>
  `),
  ].join("");
  const configured = Boolean(state.config.engine.baseUrl);
  elements.playgroundEngineStatus.classList.toggle("online", configured);
  elements.playgroundEngineStatus.innerHTML = `
    <span aria-hidden="true"></span>
    ${configured ? escapeHtml(state.config.engine.model || "Moteur configuré") : "URL du PC IA non configurée"}
  `;
  renderPlaygroundMessages();
  renderPlaygroundDebug();
}

function renderPlaygroundMessages() {
  if (!state.playgroundMessages.length) {
    elements.playgroundMessages.innerHTML = `
      <div class="empty-state">Écris un premier message pour commencer le test.</div>
    `;
    return;
  }
  elements.playgroundMessages.innerHTML = state.playgroundMessages.map((message) => `
    <article class="message ${message.role === "assistant" ? "own" : ""}">
      ${message.type === "image"
        ? `<div class="message-bubble media-bubble"><img src="${escapeHtml(message.content)}" alt="Media"></div>`
        : `<div class="message-bubble">${escapeHtml(message.content)}</div>`}
      <div class="message-meta">${message.role === "assistant" ? "BambouAI" : "Utilisateur"}</div>
    </article>
  `).join("") + (state.playgroundStopped ? `
    <div class="playground-stop-notice">
      Conversation arretee${state.playgroundStopReason ? `: ${escapeHtml(state.playgroundStopReason)}` : ""}. Reset pour relancer un test.
    </div>
  ` : "");
  requestAnimationFrame(() => {
    elements.playgroundMessages.scrollTop = elements.playgroundMessages.scrollHeight;
  });
  renderPlaygroundDebug();
}

function playgroundResponseItems(response) {
  const source = Array.isArray(response?.contentItems)
    ? response.contentItems
    : Array.isArray(response?.content)
      ? response.content
    : [];
  const items = source
    .map((item) => ({
      type: item?.type || "text",
      content: String(item?.content || "").trim(),
      itemId: String(item?.itemId || item?.mediaItemId || item?.mediaId || "").trim(),
      mediaPool: String(item?.mediaPool || "").trim(),
      disappearing: item?.disappearing === undefined ? undefined : Boolean(item.disappearing),
      delayMs: Number.isFinite(Number(item?.delayMs)) ? Number(item.delayMs) : undefined,
    }))
    .filter((item) => item.content);
  if (items.length) return items;
  const fallback = String(response?.content || "").trim();
  return fallback ? [{ type: "text", content: fallback }] : [];
}

function currentMediaVault() {
  return state.mediaLibrary?.vaults.find((vault) => vault.id === state.mediaVaultId)
    || state.mediaLibrary?.vaults[0];
}

function currentMediaDays() {
  const vault = currentMediaVault();
  return vault ? state.mediaLibrary.daysByVault[vault.id] || [] : [];
}

function mediaItemsForSelection() {
  return (state.mediaLibrary?.items || []).filter((item) =>
    item.vaultId === state.mediaVaultId
    && item.dayId === state.mediaDayId
    && item.category === state.mediaCategory
  );
}

const mediaContexts = [
  { id: "either", label: "EITHER" },
  { id: "day", label: "DAY" },
  { id: "night", label: "NIGHT" },
  { id: "nsfw", label: "NSFW" },
];

function mediaItemsForContext(contextId) {
  return mediaItemsForSelection().filter((item) => (item.context || "either") === contextId);
}

function findMediaItem(itemId) {
  return (state.mediaLibrary?.items || []).find((item) => item.id === itemId);
}

function defaultMediaOverlay(overlay = {}) {
  return {
    text: String(overlay.text || ""),
    preset: ["default", "snap", "insta"].includes(String(overlay.preset)) ? String(overlay.preset) : "default",
    y: Number.isFinite(Number(overlay.y)) ? Number(overlay.y) : 80,
    fontSize: Number.isFinite(Number(overlay.fontSize)) ? Number(overlay.fontSize) : 32,
  };
}

function renderOverlayText(value) {
  return escapeHtml(value || "").replaceAll("\n", "<br>");
}

function mediaDescriptionSuggestion(item) {
  const categoryHints = {
    primary: "selfie, face, natural",
    sad: "sad mood, emotional",
    happy: "happy, smiling",
    audio: "voice note, natural audio",
    sexy: "sexy pose, teasing",
    pose: "pose, outfit, body",
    hidden: "private media, hidden",
  };
  const contextHints = {
    either: "",
    day: "day",
    night: "night",
    nsfw: "nsfw",
  };
  const fileWords = String(item.fileName || "")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [
    categoryHints[item.category] || categoryLabel(item.category).toLocaleLowerCase("fr"),
    contextHints[item.context || "either"],
    fileWords && fileWords.length < 40 ? fileWords : "",
  ].filter(Boolean).join(", ");
}

function ensureMediaEditorModal() {
  let modal = document.querySelector("#media-editor-backdrop");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = "media-editor-backdrop";
  modal.className = "media-editor-backdrop";
  modal.hidden = true;
  document.body.append(modal);
  return modal;
}

function readMediaEditorDraft() {
  const overlay = defaultMediaOverlay({
    text: document.querySelector("#media-overlay-text")?.value || "",
    preset: document.querySelector("[data-overlay-preset].active")?.dataset.overlayPreset || "default",
    y: document.querySelector("#media-overlay-y")?.value || 80,
    fontSize: document.querySelector("#media-overlay-font-size")?.value || 32,
  });
  return {
    overlay,
    description: document.querySelector("#media-description-input")?.value || "",
    disappearing: Boolean(document.querySelector("#media-disappearing-toggle")?.checked),
  };
}

function updateMediaEditorPreview() {
  const modal = document.querySelector("#media-editor-backdrop");
  if (!modal || modal.hidden) return;
  const draft = readMediaEditorDraft();
  const previewText = modal.querySelector("#media-editor-overlay-preview");
  if (!previewText) return;
  previewText.className = `media-editor-overlay-preview ${draft.overlay.preset}`;
  previewText.style.top = `${Math.max(0, Math.min(100, draft.overlay.y))}%`;
  previewText.style.fontSize = `${Math.max(16, Math.min(72, draft.overlay.fontSize))}px`;
  previewText.innerHTML = renderOverlayText(draft.overlay.text);
  previewText.hidden = !draft.overlay.text.trim();
}

function isAudioMedia(item) {
  const mimeType = String(item?.mimeType || "").toLowerCase();
  return mimeType.startsWith("audio/") || mimeType === "application/ogg";
}

function isVideoMedia(item) {
  return String(item?.mimeType || "").startsWith("video/");
}

function mediaPreviewMarkup(item, mode = "card") {
  if (isVideoMedia(item)) return `<video controls playsinline preload="metadata" aria-label="${escapeHtml(item.description || item.fileName || "Video")}" src="${escapeHtml(item.url)}"></video>`;
  const label = escapeHtml(item.description || item.fileName || "Audio");
  if (isAudioMedia(item)) {
    return `
      <div class="media-audio-preview ${mode === "editor" ? "editor" : ""}">
        <span>AUDIO</span>
        <audio controls preload="metadata" src="${escapeHtml(item.url)}"></audio>
      </div>
    `;
  }
  return `<img src="${escapeHtml(item.url)}" alt="${label}" loading="${mode === "editor" ? "eager" : "lazy"}">`;
}

function renderMediaEditorModal(item) {
  const modal = ensureMediaEditorModal();
  const overlay = defaultMediaOverlay(item.overlay);
  const audioMedia = isAudioMedia(item);
  const overlaySection = (audioMedia || isVideoMedia(item)) ? "" : `
        <section class="media-editor-section">
          <label class="media-editor-label" for="media-overlay-text">Text Overlay:</label>
          <textarea id="media-overlay-text" rows="3" placeholder="Enter text to add on image... (Enter for new line)">${escapeHtml(overlay.text)}</textarea>

          <div class="media-overlay-preset-row" role="group" aria-label="Overlay preset">
            <button type="button" data-overlay-preset="default" class="${overlay.preset === "default" ? "active" : ""}">Default</button>
            <button type="button" data-overlay-preset="snap" class="${overlay.preset === "snap" ? "active" : ""}">Snap</button>
            <button type="button" data-overlay-preset="insta" class="${overlay.preset === "insta" ? "active" : ""}">Insta</button>
          </div>

          <div class="media-range-row">
            <label for="media-overlay-y">Position</label>
            <input id="media-overlay-y" type="range" min="0" max="100" value="${escapeHtml(overlay.y)}">
          </div>
          <div class="media-range-row">
            <label for="media-overlay-font-size">Font Size</label>
            <input id="media-overlay-font-size" type="range" min="16" max="72" value="${escapeHtml(overlay.fontSize)}">
          </div>

          <button id="media-overlay-clear" type="button" class="media-clear-button">X&nbsp; Clear</button>
        </section>`;
  modal.innerHTML = `
    <div class="media-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="media-editor-title">
      <header class="media-editor-head">
        <h2 id="media-editor-title">Edit Media Description</h2>
        <button id="media-editor-close" type="button" class="media-editor-close" aria-label="Fermer">X</button>
      </header>

      <div class="media-editor-body">
        <div class="media-editor-preview ${audioMedia ? "audio" : ""}">
          ${mediaPreviewMarkup(item, "editor")}
          ${(audioMedia || isVideoMedia(item)) ? "" : `<div id="media-editor-overlay-preview" class="media-editor-overlay-preview ${escapeHtml(overlay.preset)}"></div>`}
        </div>

        ${overlaySection}

        <section class="media-description-section">
          <label class="media-editor-label" for="media-description-input">Description:</label>
          <textarea id="media-description-input" rows="5" placeholder="Add a custom description for better AI context...">${escapeHtml(item.description || "")}</textarea>
          <p>Add custom descriptions to help the AI understand the context of this media.</p>
        </section>

        <label class="media-disappearing-row">
          <span class="media-switch">
            <input id="media-disappearing-toggle" type="checkbox" ${item.disappearing ? "checked" : ""}>
            <span></span>
          </span>
          <span>
            <strong>Disappearing media</strong>
            <small>When enabled, this media vanishes after viewing. Disable to send it as normal media.</small>
          </span>
        </label>
      </div>

      <footer class="media-editor-footer">
        <button id="media-ai-describe" type="button" class="media-ai-button">AI Describe</button>
        <div class="media-editor-footer-actions">
          <button id="media-editor-cancel" type="button" class="button secondary">Cancel</button>
          <button id="media-editor-save" type="button" class="button primary">Save</button>
        </div>
      </footer>
    </div>
  `;
  modal.hidden = false;

  modal.querySelector("#media-editor-close")?.addEventListener("click", closeMediaEditorModal);
  modal.querySelector("#media-editor-cancel")?.addEventListener("click", closeMediaEditorModal);
  modal.onclick = (event) => {
    if (event.target === modal) closeMediaEditorModal();
  };
  for (const input of modal.querySelectorAll("#media-overlay-text, #media-overlay-y, #media-overlay-font-size")) {
    input.addEventListener("input", updateMediaEditorPreview);
  }
  for (const button of modal.querySelectorAll("[data-overlay-preset]")) {
    button.addEventListener("click", () => {
      for (const candidate of modal.querySelectorAll("[data-overlay-preset]")) candidate.classList.remove("active");
      button.classList.add("active");
      updateMediaEditorPreview();
    });
  }
  modal.querySelector("#media-overlay-clear")?.addEventListener("click", () => {
    const input = modal.querySelector("#media-overlay-text");
    if (input) input.value = "";
    updateMediaEditorPreview();
  });
  modal.querySelector("#media-ai-describe")?.addEventListener("click", () => {
    const description = modal.querySelector("#media-description-input");
    if (description) {
      description.value = mediaDescriptionSuggestion(item);
      description.focus();
    }
  });
  modal.querySelector("#media-editor-save")?.addEventListener("click", saveMediaEditorModal);
  updateMediaEditorPreview();
}

function openMediaEditorModal(item) {
  state.mediaEditorItemId = item.id;
  renderMediaEditorModal(item);
}

function closeMediaEditorModal() {
  const modal = document.querySelector("#media-editor-backdrop");
  if (modal) modal.hidden = true;
  state.mediaEditorItemId = null;
}

async function saveMediaEditorModal() {
  const item = findMediaItem(state.mediaEditorItemId);
  if (!item) return;
  const saveButton = document.querySelector("#media-editor-save");
  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = "Saving...";
  }
  try {
    state.mediaLibrary = await api(`/api/media/items/${encodeURIComponent(item.id)}`, {
      method: "PATCH",
      body: readMediaEditorDraft(),
    });
    closeMediaEditorModal();
    renderMediaVaultSurface();
    showToast("Media mis a jour.");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.textContent = "Save";
    }
  }
}

function categoryLabel(category) {
  return {
    primary: "Primary",
    sad: "Sad",
    happy: "Happy",
    sexy: "Sexy",
    pose: "Pose",
    audio: "Voicenotes",
    hidden: "Hidden",
  }[category] || category;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Lecture media impossible."));
    reader.readAsDataURL(file);
  });
}

function mediaMimeTypeForFile(file) {
  const mimeType = String(file?.type || "").toLowerCase();
  if (mimeType) return mimeType;
  const name = String(file?.name || "").toLowerCase();
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".mp4")) return "video/mp4";
  if (name.endsWith(".mp3")) return "audio/mpeg";
  if (name.endsWith(".wav")) return "audio/wav";
  if (name.endsWith(".m4a")) return "audio/mp4";
  if (name.endsWith(".webm")) return "audio/webm";
  if (name.endsWith(".ogg")) return "audio/ogg";
  return "";
}

function isAudioMimeType(mimeType) {
  const normalized = String(mimeType || "").toLowerCase();
  return normalized.startsWith("audio/") || normalized === "application/ogg";
}

async function loadMediaLibrary() {
  state.mediaLibrary = await api("/api/media/library");
  if (!state.mediaVaultId || !state.mediaLibrary.vaults.some((vault) => vault.id === state.mediaVaultId)) {
    state.mediaVaultId = state.mediaLibrary.vaults[0]?.id || null;
  }
  const days = currentMediaDays();
  if (!state.mediaDayId || !days.some((day) => day.id === state.mediaDayId)) {
    state.mediaDayId = days[0]?.id || null;
  }
}

async function renderMediaVault() {
  if (!elements.mediaGrid) return;
  try {
    if (!state.mediaLibrary || !state.mediaVaultId) await loadMediaLibrary();
    renderMediaVaultSurface();
  } catch (error) {
    elements.mediaGrid.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    showToast(error.message, "error");
  }
}

function renderMediaVaultSurface() {
  const library = state.mediaLibrary;
  if (!library || !library.vaults.length) {
    elements.mediaGrid.innerHTML = `<div class="empty-state">Aucun Media Vault disponible.</div>`;
    return;
  }
  if (!state.mediaVaultId || !library.vaults.some((vault) => vault.id === state.mediaVaultId)) {
    state.mediaVaultId = library.vaults[0].id;
  }

  elements.mediaPresetSelect.innerHTML = library.vaults.map((vault) => `
    <option value="${escapeHtml(vault.id)}">${escapeHtml(vault.name)}</option>
  `).join("");
  elements.mediaPresetSelect.value = state.mediaVaultId;
  const selectedMediaVault = currentMediaVault();
  if (elements.mediaVaultIdCard && selectedMediaVault) {
    elements.mediaVaultIdCard.innerHTML = `
      <div class="media-id-row">
        <span>Vault ID</span>
        <strong>${escapeHtml(selectedMediaVault.id)}</strong>
      </div>
      <div class="media-id-row">
        <span>Independant</span>
        <strong>partageable par plusieurs presets</strong>
      </div>
    `;
  }

  const days = currentMediaDays();
  const selectedDay = days.find((day) => day.id === state.mediaDayId) || days[0];
  state.mediaDayId = selectedDay?.id || null;
  elements.mediaDayHeading.textContent = selectedDay?.name || "Outfit Day 1";

  elements.mediaDayList.innerHTML = days.map((day) => {
    const count = (library.items || []).filter((item) =>
      item.vaultId === state.mediaVaultId && item.dayId === day.id
    ).length;
    return `
      <button type="button" class="media-day-item ${day.id === state.mediaDayId ? "active" : ""}" data-media-day="${escapeHtml(day.id)}">
        <span class="module-icon">::</span>
        <span class="media-day-copy">
          <span>${escapeHtml(day.name)}</span>
          <small>${escapeHtml(day.id)}</small>
        </span>
        <strong>${count}</strong>
      </button>
    `;
  }).join("");

  for (const tab of elements.mediaCategoryTabs.querySelectorAll("[data-media-category]")) {
    tab.classList.toggle("active", tab.dataset.mediaCategory === state.mediaCategory);
  }

  const items = mediaItemsForSelection();
  elements.mediaCount.textContent = items.length;
  elements.mediaGrid.innerHTML = mediaContexts.map((context) => {
    const contextItems = mediaItemsForContext(context.id);
    return `
      <section class="media-context-section">
        <h3>${escapeHtml(context.label)}</h3>
        <div class="media-context-grid">
          ${contextItems.map((item) => `
            <article class="media-card">
              ${mediaPreviewMarkup(item)}
              ${!isAudioMedia(item) && !isVideoMedia(item) && item.overlay?.text ? `<div class="media-card-overlay ${escapeHtml(item.overlay.preset || "default")}" style="top:${escapeHtml(item.overlay.y || 80)}%;font-size:${Math.max(11, Math.round(Number(item.overlay.fontSize || 32) / 3))}px">${renderOverlayText(item.overlay.text)}</div>` : ""}
              <div class="media-card-actions">
                <button type="button" class="media-mini-button" data-media-edit="${escapeHtml(item.id)}" title="Edit description">E</button>
                <button type="button" class="media-mini-button" data-media-delete="${escapeHtml(item.id)}" title="Delete">X</button>
              </div>
              <div class="media-card-label">${escapeHtml(item.description || (item.tags || []).join(", ") || item.fileName || categoryLabel(item.category))}</div>
            </article>
          `).join("")}
          <button type="button" class="media-add-tile" data-media-add-context="${escapeHtml(context.id)}">
            <span>+</span>
            <strong>${state.mediaCategory === "audio" ? "Ajouter audio" : "Ajouter image / vidéo"}</strong>
          </button>
        </div>
      </section>
    `;
  }).join("");

  for (const button of elements.mediaDayList.querySelectorAll("[data-media-day]")) {
    button.addEventListener("click", () => {
      state.mediaDayId = button.dataset.mediaDay;
      renderMediaVaultSurface();
    });
  }
  for (const button of elements.mediaGrid.querySelectorAll("[data-media-add-context]")) {
    button.addEventListener("click", () => {
      state.mediaUploadContext = button.dataset.mediaAddContext || "either";
      elements.mediaUploadInput.click();
    });
  }
  for (const button of elements.mediaGrid.querySelectorAll("[data-media-edit]")) {
    button.addEventListener("click", () => {
      const item = (state.mediaLibrary?.items || []).find((candidate) => candidate.id === button.dataset.mediaEdit);
      if (!item) return;
      openMediaEditorModal(item);
    });
  }
  for (const button of elements.mediaGrid.querySelectorAll("[data-media-delete]")) {
    button.addEventListener("click", async () => {
      if (!window.confirm("Supprimer ce media ?")) return;
      try {
        state.mediaLibrary = await api(`/api/media/items/${encodeURIComponent(button.dataset.mediaDelete)}`, {
          method: "DELETE",
        });
        renderMediaVaultSurface();
        showToast("Media supprime.");
      } catch (error) {
        showToast(error.message, "error");
      }
    });
  }
}

async function uploadMediaFiles(files) {
  if (!files.length || !state.mediaVaultId || !state.mediaDayId) return;
  try {
    let uploaded = 0;
    for (const file of files) {
      const mimeType = mediaMimeTypeForFile(file);
      const allowedTypes = [
        "video/mp4",
        "image/jpeg",
        "image/png",
        "image/webp",
        "audio/mpeg",
        "audio/wav",
        "audio/x-wav",
        "audio/mp4",
        "audio/x-m4a",
        "audio/webm",
        "audio/ogg",
        "application/ogg",
      ];
      if (!allowedTypes.includes(mimeType)) {
        showToast(`${file.name}: format ignore.`, "error");
        continue;
      }
      const limitMB = mimeType === "video/mp4" ? 40 : isAudioMimeType(mimeType) ? 30 : 18;
      if (!file.size || file.size > limitMB * 1024 * 1024) {
        showToast(`${file.name}: fichier vide ou trop lourd (maximum ${limitMB} Mo).`, "error");
        continue;
      }
      const isAudioFile = isAudioMimeType(mimeType);
      if (state.mediaCategory === "audio" && !isAudioFile) {
        showToast(`${file.name}: choisis un fichier audio.`, "error");
        continue;
      }
      const category = isAudioFile ? "audio" : state.mediaCategory;
      const data = await fileToDataUrl(file);
      state.mediaLibrary = await api("/api/media/items", {
        method: "POST",
        body: {
          vaultId: state.mediaVaultId,
          dayId: state.mediaDayId,
          category,
          context: state.mediaUploadContext || "either",
          fileName: file.name,
          mimeType,
          data,
        },
      });
      uploaded += 1;
    }
    renderMediaVaultSurface();
    showToast(`${uploaded} media(s) ajoute(s) au Media Vault.`);
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    elements.mediaUploadInput.value = "";
  }
}

// ---- Vue "Messages bloqués" ------------------------------------------------
// ChatNow refuse certains envois SANS message d'erreur: l'extension constate
// seulement que son texte n'est jamais apparu. Elle remonte le texte fautif ici
// pour qu'on identifie les mots interdits et qu'on les remplace.
let blockedCache = { items: [], words: [], total: 0 };

async function renderBlockedMessages() {
  const container = document.querySelector("#view-blocked");
  if (!container) return;
  if (!state.config.extension || typeof state.config.extension !== "object") state.config.extension = {};
  const ext = state.config.extension;

  try {
    blockedCache = await api("/api/studio/blocked-messages");
  } catch (error) {
    showToast(error.message, "error");
  }
  const items = Array.isArray(blockedCache.items) ? blockedCache.items : [];
  const words = Array.isArray(blockedCache.words) ? blockedCache.words : [];

  const rows = items.length
    ? items.map((item) => `
        <tr>
          <td class="mono">${escapeHtml(String(item.at || "").slice(11, 16))}</td>
          <td>${escapeHtml(item.account || "")}</td>
          <td>${escapeHtml(item.preset || "")}</td>
          <td>${escapeHtml(item.message || "")}</td>
        </tr>`).join("")
    : `<tr><td colspan="4" class="field-help">Aucun message bloqué pour l'instant.</td></tr>`;

  const chips = words.length
    ? words.map((entry) => `<button type="button" class="chip" data-blocked-word="${escapeHtml(entry.word)}" title="Ajouter à la table de remplacement">${escapeHtml(entry.word)} <strong>${entry.count}</strong></button>`).join(" ")
    : `<span class="field-help">Rien à analyser.</span>`;

  container.innerHTML = `
    <div class="settings-band" style="max-width:960px;">
      <div class="band-heading"><h2>Mots à remplacer</h2></div>
      <p class="field-help">Une règle par ligne, au format <code>mot => remplacement</code>. Appliquée par l'extension <strong>avant chaque envoi</strong>, sur <strong>toutes</strong> les occurrences. Clique « Enregistrer » en haut, puis redémarre la flotte pour appliquer.</p>
      <p class="field-help">À ne pas confondre avec <strong>Abréviations générales → Substituées</strong> (page API Keys), qui sert au style d'écriture : celle-là ne remplace <strong>qu'une expression par message</strong>, ignore les messages de moins de 12 caractères et ne fait rien si la réponse contient déjà une abréviation. Parfait pour « beaucoup » → « bcp », inutilisable contre un mot qui fait refuser l'envoi — il passerait quand même une fois sur deux.</p>
      <div class="field">
        <textarea data-config-path="extension.wordReplacements" rows="6" placeholder="mym => lien&#10;snap => snapchat">${escapeHtml(ext.wordReplacements || "")}</textarea>
      </div>
    </div>
    <div class="settings-band" style="max-width:960px;">
      <div class="band-heading"><h2>Mots les plus fréquents dans les messages refusés</h2></div>
      <p class="field-help">Comptés sur ${blockedCache.total || 0} message(s). Un mot fréquent ici est un <strong>suspect</strong>, pas une preuve : c'est la comparaison avec tes messages qui passent qui tranche. Clique un mot pour l'ajouter à la table ci-dessus.</p>
      <div class="chip-row">${chips}</div>
    </div>
    <div class="settings-band" style="max-width:960px;">
      <div class="band-heading">
        <h2>Messages refusés par ChatNow (${items.length})</h2>
        <button type="button" class="ghost" id="blocked-clear">Vider</button>
      </div>
      <div class="table-wrap" style="overflow-x:auto;">
        <table class="data-table">
          <thead><tr><th>Heure</th><th>Compte</th><th>Preset</th><th>Message refusé</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;

  bindConfigControls(container);

  // Un clic sur un mot pre-remplit la regle de remplacement: c'est le geste
  // qu'on repete, autant l'avoir en un clic.
  for (const chip of container.querySelectorAll("[data-blocked-word]")) {
    chip.addEventListener("click", () => {
      const word = chip.dataset.blockedWord;
      const textarea = container.querySelector('[data-config-path="extension.wordReplacements"]');
      if (!textarea) return;
      const lines = textarea.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.some((line) => line.toLowerCase().startsWith(`${word} =>`))) {
        showToast(`"${word}" est déjà dans la table.`);
        return;
      }
      lines.push(`${word} => `);
      textarea.value = lines.join("\n");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
  }

  const clearButton = container.querySelector("#blocked-clear");
  clearButton?.addEventListener("click", async () => {
    if (!window.confirm("Vider la liste des messages refusés ?")) return;
    try {
      await api("/api/studio/blocked-messages/clear", { method: "POST" });
      showToast("Liste vidée.");
      renderBlockedMessages();
    } catch (error) {
      showToast(error.message, "error");
    }
  });
}

function renderOmegleweb() {
  const container = document.querySelector("#view-omegleweb");
  if (!container) return;
  if (!state.config.extension || typeof state.config.extension !== "object") state.config.extension = {};
  const ext = state.config.extension;
  container.innerHTML = `
    <div class="settings-band" style="max-width:760px;">
      <div class="band-heading"><h2>Webhooks Discord (alertes ban / blocage)</h2></div>
      <p class="field-help">Un webhook par plateforme. <strong>Laisser vide</strong> = le webhook par défaut codé dans l'extension / worker est utilisé (fallback). Clique « Enregistrer » en haut pour appliquer. Prend effet après rechargement de l'extension / redémarrage des workers.</p>
      <div class="field">
        <label>omegleweb.com (workers headless)</label>
        <input data-config-path="extension.webhookOmegleCom" value="${escapeHtml(ext.webhookOmegleCom || "")}" placeholder="https://discord.com/api/webhooks/…  (vide = défaut)">
      </div>
      <div class="field">
        <label>omegleweb.io (extension)</label>
        <input data-config-path="extension.webhookOmegleIo" value="${escapeHtml(ext.webhookOmegleIo || "")}" placeholder="https://discord.com/api/webhooks/…  (vide = défaut)">
      </div>
      <div class="field">
        <label>ChatNow (extension)</label>
        <input data-config-path="extension.webhookChatnow" value="${escapeHtml(ext.webhookChatnow || "")}" placeholder="https://discord.com/api/webhooks/…  (vide = défaut)">
      </div>
    </div>
    <div class="settings-band" style="max-width:760px;">
      <div class="band-heading"><h2>OmegleWeb</h2></div>
      <p class="field-help">Appliqués par l'extension omegleweb.io (rafraîchis toutes les 60 s). (« Forcer l'opener » est par preset, dans la section Openers.)</p>
      <div class="field">
        <label>Messages à skip (bots / spam) — une phrase par ligne</label>
        <textarea data-config-path="extension.omegleSkipMessages" rows="6" placeholder="check my profile">${escapeHtml(ext.omegleSkipMessages || "")}</textarea>
      </div>
      <div class="field">
        <label>Pays à ignorer — codes ISO-2 séparés par des virgules</label>
        <input data-config-path="extension.omegleSkipCountries" value="${escapeHtml(ext.omegleSkipCountries || "")}" placeholder="IN, PK, BD">
      </div>
    </div>
  `;
  bindConfigControls(container);
}

// ---- Settings Snapchat -----------------------------------------------------

function ensureSnapchatShape() {
  const s = (state.config.snapchat && typeof state.config.snapchat === "object")
    ? state.config.snapchat : {};
  s.limits24h = s.limits24h && typeof s.limits24h === "object" ? s.limits24h : {};
  s.limits24h.acceptIncoming = Number(s.limits24h.acceptIncoming ?? 50);
  s.limits24h.addMutual = Number(s.limits24h.addMutual ?? 30);
  s.limits24h.addFromList = Number(s.limits24h.addFromList ?? 40);
  s.addsPerAccountBeforeRotate = Number(s.addsPerAccountBeforeRotate ?? 20);
  s.targetList = String(s.targetList ?? "");
  s.handleUrlTemplate = String(s.handleUrlTemplate ?? "{username}");
  s.accounts = s.accounts && typeof s.accounts === "object" ? s.accounts : {};
  for (const key of ["stock", "receiving", "overflow", "banned"]) {
    s.accounts[key] = Array.isArray(s.accounts[key]) ? s.accounts[key] : [];
  }
  s.modelSetups = Array.isArray(s.modelSetups) ? s.modelSetups : [];
  s.rdps = Array.isArray(s.rdps) ? s.rdps : [];
  s.proxies = Array.isArray(s.proxies) ? s.proxies : [];
  s.proxyType = String(s.proxyType ?? "http");
  s.adspowerSerials = Array.isArray(s.adspowerSerials) ? s.adspowerSerials : [];
  s.pacing = s.pacing && typeof s.pacing === "object" ? s.pacing : {};
  s.pacing.timezone = String(s.pacing.timezone ?? "Europe/Paris");
  s.pacing.sleepStartEarliestHour = Number(s.pacing.sleepStartEarliestHour ?? 22);
  s.pacing.sleepStartLatestHour = Number(s.pacing.sleepStartLatestHour ?? 4);
  s.pacing.sleepDurationHours = Number(s.pacing.sleepDurationHours ?? 7);
  s.pacing.jitterMinutes = Number(s.pacing.jitterMinutes ?? 60);
  s.pacing.breaksPerDay = Number(s.pacing.breaksPerDay ?? 2);
  s.pacing.breakMinutes = Number(s.pacing.breakMinutes ?? 60);
  s.pacing.microBreakChance = Number(s.pacing.microBreakChance ?? 20);
  s.pacing.microBreakMinMinutes = Number(s.pacing.microBreakMinMinutes ?? 5);
  s.pacing.microBreakMaxMinutes = Number(s.pacing.microBreakMaxMinutes ?? 10);
  s.pacing.addSpacingMinMinutes = Number(s.pacing.addSpacingMinMinutes ?? 30);
  s.pacing.addSpacingMaxMinutes = Number(s.pacing.addSpacingMaxMinutes ?? 60);
  state.config.snapchat = s;
  return s;
}

// Fuseaux proposes dans la liste. La valeur enregistree reste une chaine IANA
// libre: si le fuseau voulu n'est pas la, il suffit de le taper.
const SNAP_TIMEZONES = [
  "Europe/Paris", "Europe/Brussels", "Europe/London", "Europe/Madrid",
  "Europe/Berlin", "Europe/Lisbon", "America/Montreal", "America/New_York",
  "America/Chicago", "America/Denver", "America/Los_Angeles", "UTC",
];

// Miroir cote navigateur de parseProxyLine() dans src/snap-proxy-pool.mjs: sert
// uniquement a compter/signaler les lignes mal formees avant l'enregistrement.
// Le serveur reste la reference.
function snapParseProxyLine(raw) {
  const line = String(raw || "").trim();
  if (!line || line.startsWith("#")) return null;
  const bar = line.indexOf("|");
  const rest = bar === -1 ? line : line.slice(bar + 1).trim();
  const parts = rest.split(":");
  if (parts.length < 2) return null;
  const port = Number(parts[1]);
  if (!parts[0].trim() || !Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return { host: parts[0].trim(), port };
}

function snapProxySummary(lines) {
  const seen = new Set();
  let ok = 0;
  const bad = [];
  (lines || []).forEach((raw, index) => {
    const text = String(raw || "").trim();
    if (!text || text.startsWith("#")) return;
    if (!snapParseProxyLine(text)) { bad.push(index + 1); return; }
    if (seen.has(text)) return;
    seen.add(text);
    ok += 1;
  });
  return { ok, bad };
}

// Apercu "il est telle heure la-bas, donc la persona dort/est eveillee". C'est
// la verification qui evite de deployer une fenetre inversee sans s'en rendre
// compte — le bug qu'on vient justement de corriger.
function snapPacingPreview(pacing) {
  const tz = String(pacing.timezone || "Europe/Paris");
  let nowLabel;
  try {
    nowLabel = new Intl.DateTimeFormat("fr-FR", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  } catch {
    return `<span class="pill pill-warn">Fuseau inconnu — verifiez l'identifiant IANA</span>`;
  }
  const [h, m] = nowLabel.split(":").map(Number);
  const minutes = h * 60 + m;
  const lo = Math.round(Number(pacing.sleepStartEarliestHour) || 0);
  const hi = Math.round(Number(pacing.sleepStartLatestHour) || 0);
  const dur = Math.round(Number(pacing.sleepDurationHours) || 0);
  const pad = (h) => String(((h % 24) + 24) % 24).padStart(2, "0") + "h";
  const local = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  // Chaque compte tire SON heure de coucher: on ne peut pas dire ici s'il dort,
  // seulement decrire la plage possible.
  return `Il est <strong>${nowLabel}</strong> a ${escapeHtml(tz)} (${local} sur cet ordinateur).
    Chaque compte se couche entre <strong>${pad(lo)}</strong> et <strong>${pad(hi)}</strong> et dort <strong>${dur} h</strong> :
    reveil entre ${pad(lo + dur)} et ${pad(hi + dur)}, selon la nuit.`;
}

// Client-side mirror of computeRdpMaxInstances() in studio-config.js.
function snapRdpMaxInstances(rdp) {
  const ramMb = Number(rdp.ramMb) || 0;
  if (ramMb <= 0) return 0;
  const osReserveMb = Number(rdp.osReserveMb) || 8192;
  const perInstanceMb = Math.max(Number(rdp.perInstanceMb) || 2000, 256);
  const perInstanceCores = Math.max(Number(rdp.perInstanceCores) || 2, 1);
  const cpuOvercommit = Number(rdp.cpuOvercommit) > 0 ? Number(rdp.cpuOvercommit) : 2;
  const byRam = Math.floor((ramMb - osReserveMb) / (perInstanceMb * 1.2));
  const byCpu = Math.floor(((Number(rdp.cpuCores) || 0) * cpuOvercommit) / perInstanceCores);
  return Math.max(0, Math.min(byRam, byCpu));
}

// Etat de la flotte (placements + agents). `refresh` interroge les agents des
// RDP (plus lent); sans lui on ne lit que le registre cote dashboard.
async function loadSnapFleet({ refresh = false, quiet = true } = {}) {
  if (state.snapFleetLoading) return;
  state.snapFleetLoading = true;
  try {
    const data = await api(refresh ? "/api/snap/status" : "/api/snap/rdps");
    state.snapFleet = refresh ? data.fleet : data;
    if (refresh) state.snapFleetReports = data.reports || [];
    if (!quiet) showToast("Etat de la flotte rafraichi.");
  } catch (error) {
    if (!quiet) showToast(error.message, "error");
  } finally {
    state.snapFleetLoading = false;
  }
  // Sante de la flotte pur-HTTP (lecture disque, independante des agents RDP/LDPlayer).
  try { state.snapHealth = await api("/api/snap/fleet-health"); } catch { /* vieux serveur sans la route */ }
  if (state.activeView === "snapchat") renderSnapchat();
}

function snapFleetRdpInfo(rdpId) {
  return (state.snapFleet?.rdps || []).find((r) => r.id === rdpId) || null;
}


// Comptes qui tournent mais butent sur le reseau ou leur proxy. Ils ne sont ni
// bannis ni en quarantaine — le worker retente toutes les 10 min — mais sans
// affichage un proxy mort est indiscernable d'un compte simplement calme.
function snapIssuesBand(issues) {
  if (!Array.isArray(issues) || !issues.length) return "";
  const age = (since) => {
    const min = Math.round((Date.now() - new Date(since).getTime()) / 60000);
    if (!Number.isFinite(min) || min < 0) return "";
    return min < 60 ? `${min} min` : `${Math.round(min / 60)} h`;
  };
  const ligne = (i, label) =>
    `<li><code>${escapeHtml(i.account)}</code> — ${label}, depuis ${age(i.since)} (${i.count || 1} tentative${(i.count || 1) > 1 ? "s" : ""})`
    + `${i.evidence ? ` <span style="opacity:.7;">— ${escapeHtml(String(i.evidence).slice(0, 120))}</span>` : ""}</li>`;

  // Les deux cas n'appellent pas du tout la meme reaction, et le bandeau les
  // melangeait sous "probleme reseau, ni banni ni arrete" — ce qui est faux
  // pour une session perdue: le compte est arrete et ne reviendra pas.
  const perdus = issues.filter((i) => i.kind === "session_perdue");
  const autres = issues.filter((i) => i.kind !== "session_perdue");
  let html = "";

  if (perdus.length) {
    html += `<div class="field-help" style="color:#c0392b;">
      <strong>Session perdue sur ${perdus.length} compte${perdus.length > 1 ? "s" : ""}</strong>
      — irrecuperable: Snap redemande un code SMS sur le numero d'inscription, dont la location est rendue.
      Ces comptes sont arretes; il faut les remplacer.
      <ul style="margin:.4em 0 0 1.2em;">${perdus.map((i) => ligne(i, "session perdue")).join("")}</ul>
    </div>`;
  }
  if (autres.length) {
    html += `<div class="field-help" style="color:#e67e22;">
      <strong>Probleme sur ${autres.length} compte${autres.length > 1 ? "s" : ""}</strong>
      — le worker retente toutes les 10 min, le compte n'est ni banni ni arrete.
      <ul style="margin:.4em 0 0 1.2em;">${autres.map((i) => ligne(i, i.kind === "network" ? "reseau / proxy" : escapeHtml(i.kind || "inconnu"))).join("")}</ul>
    </div>`;
  }
  return html;
}
function renderSnapchat() {
  const container = document.querySelector("#view-snapchat");
  if (!container) return;
  if (!state.config) return; // config not loaded yet (mirrors renderStudio)
  const s = ensureSnapchatShape();
  const presets = configPresets();
  const vaults = mediaVaultAccountOptions();

  const presetOptions = (selected) => presetOptionsHtml(presets, selected);
  const vaultOptions = (selected) => vaults.map((v) => `
    <option value="${escapeHtml(v.id)}" ${v.id === (selected || "") ? "selected" : ""}>${escapeHtml(v.name)}${v.id ? ` (${escapeHtml(v.id)})` : ""}</option>
  `).join("");

  const modelRows = s.modelSetups.map((m, i) => `
    <div class="settings-band" style="max-width:820px;">
      <div class="band-heading" style="display:flex;justify-content:space-between;align-items:center;">
        <h3 style="margin:0;">${escapeHtml(m.name || `Model ${i + 1}`)}</h3>
        <button type="button" class="button secondary" data-remove-model="${i}">Supprimer</button>
      </div>
      <div class="field">
        <label>Nom du model setup</label>
        <input data-config-path="snapchat.modelSetups.${i}.name" value="${escapeHtml(m.name || "")}" placeholder="Lina">
      </div>
      <div class="field">
        <label>Cle model (utilisee par la plateforme "snap" des URLs)</label>
        <input data-config-path="snapchat.modelSetups.${i}.model" value="${escapeHtml(m.model || "")}" placeholder="lina, mia, other…">
      </div>
      <div class="field">
        <label>Preset (persona / comportement IA)</label>
        <select data-config-path="snapchat.modelSetups.${i}.presetId">${presetOptions(m.presetId)}</select>
      </div>
      <div class="field">
        <label>Media Vault</label>
        <select data-config-path="snapchat.modelSetups.${i}.mediaVaultId">${vaultOptions(m.mediaVaultId)}</select>
      </div>
      <div class="field">
        <label>Comptes Snap de ce model (un username par ligne)</label>
        <textarea data-config-path="snapchat.modelSetups.${i}.accountPool" data-list="lines" rows="3" placeholder="lina9483placeholder="lina9483&#10;ceryun"#10;ceryun (username seul: les identifiants viennent des listes ci-dessus)">${escapeHtml((m.accountPool || []).join("\n"))}</textarea>
      </div>
    </div>
  `).join("");

  const totalCapacity = s.rdps.reduce((sum, r) => sum + (Number(r.maxInstances) || snapRdpMaxInstances(r)), 0);
  const totalLoad = s.rdps.reduce((sum, r) => sum + (Number(r.currentLoad) || 0), 0);

  // Comptes places sur ce RDP + retour du dernier /api/snap/status.
  const fleetLine = (r) => {
    const info = snapFleetRdpInfo(r.id);
    if (!info) return "";
    const report = (state.snapFleetReports || []).find((x) => x.rdpId === r.id);
    const agent = report?.agent;
    const accounts = info.accounts.map((a) => `
      <li style="display:flex;align-items:center;gap:8px;margin:2px 0;">
        <code>${escapeHtml(a.username)}</code>
        <span style="opacity:.65;">${escapeHtml(a.instanceName || "")}${a.instanceIndex != null ? ` (#${a.instanceIndex})` : ""}${a.provisionState ? ` · ${escapeHtml(a.provisionState)}` : ""}${a.provisionError ? ` · ${escapeHtml(a.provisionError)}` : ""}</span>
        <button type="button" class="button secondary" data-unplace="${escapeHtml(a.username)}" style="padding:1px 8px;font-size:11px;">Detacher</button>
      </li>`).join("");
    return `
      <p class="field-help">Places : <strong>${info.load} / ${info.capacity}</strong> (${info.free} libre${info.free > 1 ? "s" : ""})${
      agent ? ` · agent v${escapeHtml(String(agent.version || "?"))} · ${agent.instancesRunning}/${agent.instancesTotal} instances actives · ${agent.jobsActive} job(s)` : ""
    }${report && !report.ok ? ` · <span style="color:#e74c3c;">${escapeHtml(report.error || "agent injoignable")}</span>` : ""}${
      agent?.ldplayerError ? ` · <span style="color:#e74c3c;">LDPlayer: ${escapeHtml(agent.ldplayerError)}</span>` : ""
    }</p>
      ${accounts ? `<ul style="margin:4px 0 8px;padding-left:16px;font-size:12px;list-style:none;">${accounts}</ul>` : ""}`;
  };
  const rdpRows = s.rdps.map((r, i) => {
    const auto = snapRdpMaxInstances(r);
    const status = String(r.status || "offline");
    const dot = status === "online" ? "#2ecc71" : status === "error" ? "#e74c3c" : "#7f8c8d";
    return `
    <div class="settings-band" style="max-width:820px;">
      <div class="band-heading" style="display:flex;justify-content:space-between;align-items:center;">
        <h3 style="margin:0;">
          <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${dot};margin-right:6px;"></span>
          ${escapeHtml(r.label || r.host || `RDP ${i + 1}`)}
        </h3>
        <button type="button" class="button secondary" data-remove-rdp="${i}">Supprimer</button>
      </div>
      <p class="field-help">Charge ${Number(r.currentLoad) || 0} / ${Number(r.maxInstances) || auto} instances · capacite auto calculee: <strong>${auto}</strong> (2000MB + 2 coeurs / instance)${r.lastSeen ? ` · vu ${escapeHtml(String(r.lastSeen))}` : ""}</p>
      ${fleetLine(r)}
      <div class="field"><label>Nom / label</label><input data-config-path="snapchat.rdps.${i}.label" value="${escapeHtml(r.label || "")}" placeholder="RDP2 Hetzner"></div>
      <div class="field"><label>Hote (IP)</label><input data-config-path="snapchat.rdps.${i}.host" value="${escapeHtml(r.host || "")}" placeholder="135.181.180.242"></div>
      <div class="field"><label>Port SSH</label><input type="number" data-config-path="snapchat.rdps.${i}.sshPort" value="${Number(r.sshPort) || 22}"></div>
      <div class="field"><label>Utilisateur SSH</label><input data-config-path="snapchat.rdps.${i}.user" value="${escapeHtml(r.user || "root")}"></div>
      <div class="field"><label>Port de l'agent snap</label><input type="number" data-config-path="snapchat.rdps.${i}.agentPort" value="${Number(r.agentPort) || 8799}"></div>
      <div class="field"><label>Token de l'agent (bearer)</label><input data-config-path="snapchat.rdps.${i}.agentToken" value="${escapeHtml(r.agentToken || "")}" placeholder="genere a la mise en place de l'agent"></div>
      <div class="field"><label>OS</label>
        <select data-config-path="snapchat.rdps.${i}.os">
          <option value="windows" ${r.os === "windows" ? "selected" : ""}>Windows</option>
          <option value="linux" ${r.os === "linux" ? "selected" : ""}>Linux</option>
        </select>
      </div>
      <div class="field"><label>RAM (MB)</label><input type="number" data-config-path="snapchat.rdps.${i}.ramMb" value="${Number(r.ramMb) || 0}" placeholder="130992"></div>
      <div class="field"><label>Coeurs logiques</label><input type="number" data-config-path="snapchat.rdps.${i}.cpuCores" value="${Number(r.cpuCores) || 0}" placeholder="24"></div>
      <div class="field"><label>Sur-allocation CPU (overcommit)</label><input type="number" data-config-path="snapchat.rdps.${i}.cpuOvercommit" value="${Number(r.cpuOvercommit) || 2}" step="0.5"></div>
      <div class="field"><label>RAM par instance (MB)</label><input type="number" min="256" data-config-path="snapchat.rdps.${i}.perInstanceMb" value="${Number(r.perInstanceMb) || 2000}"><p class="field-help">Le calcul applique +20% de surcout hote (une instance a 2000 MB coute ~2,4 GB reels).</p></div>
      <div class="field"><label>Coeurs par instance</label><input type="number" min="1" data-config-path="snapchat.rdps.${i}.perInstanceCores" value="${Number(r.perInstanceCores) || 2}"><p class="field-help">Mesure sur le terrain: une instance tourne en <strong>1 coeur / 2000 MB</strong>. A 1, c'est la RAM qui plafonne, plus le CPU.</p></div>
      <div class="field"><label>Reserve OS (MB)</label><input type="number" min="0" data-config-path="snapchat.rdps.${i}.osReserveMb" value="${Number(r.osReserveMb) || 8192}"></div>
      <div class="field"><label>Max instances (0 = auto)</label><input type="number" data-config-path="snapchat.rdps.${i}.maxInstances" value="${Number(r.maxInstances) || 0}" placeholder="${auto}"></div>
    </div>
  `;
  }).join("");

  const proxySummary = snapProxySummary(s.proxies);
  const fleet = state.snapFleet;
  const fleetSummary = !fleet
    ? `<p class="field-help">Etat de la flotte non charge.</p>`
    : `
      <p class="field-help">Comptes connus : <strong>${fleet.totals.accounts}</strong> · places : <strong>${fleet.totals.load}</strong> · capacite : <strong>${fleet.totals.capacity}</strong> (${fleet.totals.free} libre${fleet.totals.free > 1 ? "s" : ""}).</p>
      ${fleet.unplaced.length ? `<p class="field-help">Non places (${fleet.unplaced.length}) : ${fleet.unplaced.map((u) => `<code>${escapeHtml(u)}</code>`).join(" ")}</p>` : `<p class="field-help">Tous les comptes connus sont places.</p>`}
      ${fleet.orphans.length ? `<p class="field-help" style="color:#e74c3c;">Placements orphelins (RDP supprime) : ${fleet.orphans.map((o) => `<code>${escapeHtml(o.username)}</code>`).join(" ")} — « Detacher » depuis la carte du RDP n'est plus possible, utilise /api/snap/unplace.</p>` : ""}
      ${snapIssuesBand(fleet.issues)}`;

  // Sante de la flotte pur-HTTP (lane clair) : qui tourne, qui est mort (re-login), TTL cookies.
  const health = state.snapHealth;
  const healthBand = (() => {
    if (!health || !health.summary) return "";
    const { summary, accounts = [], cookieTtl } = health;
    const badge = (a) => a.needsRelogin
      ? `<span class="online-status banned">re-login</span>`
      : a.running ? `<span class="online-status">actif</span>`
        : `<span class="online-status discarded">arrete</span>`;
    const rows = accounts.map((a) => `
      <li style="display:flex;align-items:center;gap:8px;margin:2px 0;">
        <code>${escapeHtml(a.account)}</code>
        ${badge(a)}
        <span style="opacity:.65;font-size:11px;">${a.e2e ? "· fils E2E → navigateur " : ""}${a.restarts ? `· ${a.restarts} redem. ` : ""}${a.cookieTtlHours ? `· cookies ~${escapeHtml(String(a.cookieTtlHours))}h` : ""}</span>
      </li>`).join("");
    const ttl = cookieTtl && cookieTtl.count
      ? `<p class="field-help">TTL cookies mesure (${cookieTtl.count} mort${cookieTtl.count > 1 ? "s" : ""}) : mediane <strong>~${escapeHtml(String(cookieTtl.medianHours))}h</strong> (min ${escapeHtml(String(cookieTtl.minHours))}h · max ${escapeHtml(String(cookieTtl.maxHours))}h).</p>`
      : `<p class="field-help">TTL cookies : pas encore de donnee mesuree.</p>`;
    const reloginWarn = summary.needsRelogin
      ? `<p class="field-help" style="color:#e74c3c;"><strong>${summary.needsRelogin} compte(s) a re-loguer</strong> — re-capture navigateur requise (snap-session-capture.mjs). Reprise auto des re-capture.</p>`
      : "";
    return `
      <div class="settings-band" style="max-width:820px;">
        <div class="band-heading"><h2>Flotte pur-HTTP — sante (lane clair)</h2></div>
        ${!summary.fleetUp
          ? `<p class="field-help">Flotte pur-HTTP pas encore lancee. Demarrer sur le RDP : <code>node snap-fleet.mjs</code>.</p>`
          : `<p class="field-help">Comptes : <strong>${summary.total}</strong> · actifs : <strong>${summary.running}</strong> · a re-loguer : <strong>${summary.needsRelogin}</strong> · avec fils E2E : <strong>${summary.e2eThreads}</strong>.</p>
             ${reloginWarn}${ttl}
             ${rows ? `<ul style="margin:4px 0 8px;padding-left:0;font-size:12px;list-style:none;">${rows}</ul>` : ""}`}
      </div>`;
  })();

  container.innerHTML = `
    ${healthBand}
    <div class="settings-band" style="max-width:820px;">
      <div class="band-heading"><h2>Rythme &amp; fenetre d'activite</h2></div>
      <p class="field-help">Heures pendant lesquelles les personas repondent sur Snap. La fenetre est evaluee dans le <strong>fuseau choisi ici</strong>, jamais dans l'heure locale du RDP — les RDP sont en Pacific Standard Time, donc sans ce reglage une fenetre 8h-minuit tomberait a 17h-9h en France. Les workers relisent cette config toutes les 5 minutes, sans redemarrage.</p>
      <div class="field">
        <label>Fuseau horaire de reference (IANA)</label>
        <input list="snap-tz-list" data-config-path="snapchat.pacing.timezone" value="${escapeHtml(s.pacing.timezone)}" placeholder="Europe/Paris">
        <datalist id="snap-tz-list">${SNAP_TIMEZONES.map((tz) => `<option value="${escapeHtml(tz)}"></option>`).join("")}</datalist>
        <p class="field-help">Identifiant IANA. Les propositions couvrent les cas courants; toute autre valeur valide est acceptee.</p>
      </div>
      <div class="grid-3">
        <div class="field"><label>Coucher au plus tot</label><input type="number" min="0" max="23" data-config-path="snapchat.pacing.sleepStartEarliestHour" value="${s.pacing.sleepStartEarliestHour}"></div>
        <div class="field"><label>Coucher au plus tard</label><input type="number" min="0" max="23" data-config-path="snapchat.pacing.sleepStartLatestHour" value="${s.pacing.sleepStartLatestHour}"></div>
        <div class="field"><label>Duree de la nuit (h)</label><input type="number" min="1" max="16" data-config-path="snapchat.pacing.sleepDurationHours" value="${s.pacing.sleepDurationHours}"></div>
      </div>
      <p class="field-help">L'heure du coucher est <strong>tiree chaque nuit</strong> entre ces deux bornes, la duree est <strong>fixe</strong> : coucher a 23h23 &rarr; reveil a 6h23. Le tirage depend du compte et du jour, donc deux comptes ne se couchent pas ensemble et aucun ne se couche a heure fixe. Une borne "au plus tard" <em>inferieure</em> a "au plus tot" traverse minuit (22 &rarr; 4).</p>
      <div class="field"><label>Desynchronisation par compte (minutes)</label><input type="number" min="0" max="720" data-config-path="snapchat.pacing.jitterMinutes" value="${s.pacing.jitterMinutes}"><p class="field-help">Decalage stable de +/- cette duree, derive du username. Sans lui, tous les comptes s'endorment a la meme seconde — la signature d'une flotte pilotee par un seul scheduler. <code>0</code> desactive.</p></div>
      <div class="grid-2">
        <div class="field"><label>Pauses par jour</label><input type="number" min="0" max="6" data-config-path="snapchat.pacing.breaksPerDay" value="${s.pacing.breaksPerDay}"></div>
        <div class="field"><label>Duree d'une pause (minutes)</label><input type="number" min="0" max="480" data-config-path="snapchat.pacing.breakMinutes" value="${s.pacing.breakMinutes}"></div>
      </div>
      <p class="field-help">Coupures reparties dans la fenetre d'activite : avec 2 pauses, elles tombent vers le tiers et les deux tiers de la journee. Chaque compte les decale de +/- 45 min, et <strong>le decalage change chaque jour</strong> — sinon toute la flotte s'arreterait a la meme minute tous les jours. <code>0</code> desactive.</p>
      <p class="field-help">${(() => {
        const n = Math.max(0, Math.round(s.pacing.breaksPerDay));
        const d = Math.max(0, Math.round(s.pacing.breakMinutes));
        // Fenetre eveillee moyenne: 24h moins la nuit. Elle varie en realite de
        // quelques heures selon l'ecart entre deux couchers tires.
        const span = Math.max(1, 24 - Math.round(s.pacing.sleepDurationHours));
        if (!n || !d) return "Aucune pause : les comptes repondent en continu sur toute la fenetre.";
        if (n * d >= span * 60) return `<span style="color:#e74c3c;">${n} x ${d} min ne tient pas dans une fenetre de ~${span} h — les pauses seront ignorees.</span>`;
        return `Temps de travail effectif : <strong>~${Math.round((span * 60 - n * d) / 6) / 10} h</strong> sur une fenetre eveillee de ~${span} h.`;
      })()}</p>
      <div class="grid-3">
        <div class="field"><label>Micro-pauses : chance par heure (%)</label><input type="number" min="0" max="100" data-config-path="snapchat.pacing.microBreakChance" value="${s.pacing.microBreakChance}"></div>
        <div class="field"><label>Duree mini (min)</label><input type="number" min="1" max="59" data-config-path="snapchat.pacing.microBreakMinMinutes" value="${s.pacing.microBreakMinMinutes}"></div>
        <div class="field"><label>Duree maxi (min)</label><input type="number" min="1" max="59" data-config-path="snapchat.pacing.microBreakMaxMinutes" value="${s.pacing.microBreakMaxMinutes}"></div>
      </div>
      <p class="field-help">En plus des grandes pauses : a chaque heure, cette probabilite que le compte decroche quelques minutes, comme quelqu'un qui pose son telephone. ${
        s.pacing.microBreakChance > 0
          ? `Environ <strong>${Math.round((s.pacing.microBreakChance / 100) * 16 * 10) / 10} coupures</strong> par tranche de 16 h, de ${s.pacing.microBreakMinMinutes} a ${s.pacing.microBreakMaxMinutes} min.`
          : "Desactivees."
      } Le tirage est <strong>deterministe</strong> (compte + jour + heure) : une pause commencee ne clignote pas d'un sondage a l'autre, et deux comptes ne s'arretent pas ensemble.</p>
      <p class="field-help">${snapPacingPreview(s.pacing)}</p>
    </div>

    <div class="settings-band" style="max-width:820px;">
      <div class="band-heading"><h2>Proxys des comptes Snap</h2></div>
      <p class="field-help">Un proxy par ligne, au format <code>host:port:utilisateur:motdepasse</code>. Ces proxys servent aux profils <strong>natifs</strong> (puppeteer) — AdsPower n'est plus utilise. Prefixe <code>socks5|</code> possible pour forcer le type d'une ligne. Les lignes vides et celles commencant par <code>#</code> sont ignorees.</p>
      <p class="field-help">Chaque compte Snap recoit <strong>une ligne qui lui reste attribuee</strong> (<code>data/snap-proxies.json</code>) : deux comptes ne partagent pas une IP, et ajouter des lignes ne redistribue pas les comptes existants. Un compte dont l'IP de sortie change tous les jours est un compte qui se signale.</p>
      <div class="field">
        <label>Type par defaut</label>
        <select data-config-path="snapchat.proxyType">
          ${["http", "https", "socks5"].map((t) => `<option value="${t}"${s.proxyType === t ? " selected" : ""}>${t}</option>`).join("")}
        </select>
        <p class="field-help">S'applique aux lignes sans prefixe explicite.</p>
      </div>
      <div class="field">
        <label>Liste de proxys (${proxySummary.ok} valide${proxySummary.ok > 1 ? "s" : ""}${proxySummary.bad.length ? `, ${proxySummary.bad.length} invalide${proxySummary.bad.length > 1 ? "s" : ""}` : ""})</label>
        <textarea data-config-path="snapchat.proxies" data-list="lines" rows="8" spellcheck="false" placeholder="residential.proxeasy.net:823:utilisateur__cr.fr;sessid.abc123:motdepasse&#10;socks5|autre.proxy.net:1080:user:pass">${escapeHtml((s.proxies || []).join("\n"))}</textarea>
        ${proxySummary.bad.length
          ? `<p class="field-help" style="color:#e74c3c;">Lignes ignorees car illisibles : ${proxySummary.bad.join(", ")}. Attendu <code>host:port:user:pass</code> — le mot de passe peut contenir des <code>:</code>, le nom d'utilisateur des <code>;</code>.</p>`
          : `<p class="field-help">Les doublons sont retires a l'enregistrement.</p>`}
      </div>
    </div>

    <div class="settings-band" style="max-width:820px;">
      <div class="band-heading"><h2>Limites par compte (24h) &amp; rotation</h2></div>
      <p class="field-help">Plafonds appliques par compte Snap et par tranche de 24h. « Enregistrer » en haut applique la config.</p>
      <div class="field"><label>Acceptation de demandes d'amis / 24h</label><input type="number" min="0" data-config-path="snapchat.limits24h.acceptIncoming" value="${s.limits24h.acceptIncoming}"></div>
      <div class="field"><label>Ajout d'amis en commun / 24h</label><input type="number" min="0" data-config-path="snapchat.limits24h.addMutual" value="${s.limits24h.addMutual}"></div>
      <div class="field"><label>Ajout depuis la liste .txt / 24h</label><input type="number" min="0" data-config-path="snapchat.limits24h.addFromList" value="${s.limits24h.addFromList}"><p class="field-help">Compteur sur <strong>24h glissantes</strong>, pas "depuis minuit" : sinon un compte ferait son quota a 23h59 puis le meme a 00h01.</p></div>
      <div class="grid-2">
        <div class="field"><label>Delai entre deux ajouts : mini (min)</label><input type="number" min="0" max="720" data-config-path="snapchat.pacing.addSpacingMinMinutes" value="${s.pacing.addSpacingMinMinutes}"></div>
        <div class="field"><label>maxi (min)</label><input type="number" min="0" max="720" data-config-path="snapchat.pacing.addSpacingMaxMinutes" value="${s.pacing.addSpacingMaxMinutes}"></div>
      </div>
      <p class="field-help">Le plafond ci-dessus dit <strong>combien</strong>, ceci dit <strong>a quel rythme</strong>. L'ecart est <strong>tire dans l'intervalle apres chaque ajout</strong> : un delai fixe serait lui-meme un motif reperable. Les ajouts n'ont lieu que quand le compte est eveille — pauses comprises. ${(() => {
        const lo = Math.max(0, Math.round(s.pacing.addSpacingMinMinutes));
        const hi = Math.max(lo, Math.round(s.pacing.addSpacingMaxMinutes));
        const n = Math.max(0, Math.round(s.limits24h.addFromList));
        if (!hi || !n) return "A <code>0</code>, les ajouts s'enchainent par lots de 3.";
        const loH = Math.round((n - 1) * lo / 6) / 10;
        const hiH = Math.round((n - 1) * hi / 6) / 10;
        return `${n} ajouts s'etalent sur <strong>${loH} a ${hiH} h</strong> (moyenne ~${Math.round((n - 1) * (lo + hi) / 2 / 6) / 10} h).`;
      })()}</p>
      <div class="field"><label>Ajouts par compte avant de changer de compte cible</label><input type="number" min="1" data-config-path="snapchat.addsPerAccountBeforeRotate" value="${s.addsPerAccountBeforeRotate}"></div>
      <div class="field"><label>Valeur poussee aux inconnus (&#123;username&#125; = handle)</label><input data-config-path="snapchat.handleUrlTemplate" value="${escapeHtml(s.handleUrlTemplate)}" placeholder="{username}"><p class="field-help">Par defaut le username brut. Ex: <code>{username}</code> ou <code>snapchat.com/add/{username}</code>.</p></div>
    </div>

    <div class="settings-band" style="max-width:820px;">
      <div class="band-heading"><h2>Comptes Snap</h2></div>
      <p class="field-help">Un compte par ligne, au format <code>username:motdepasse:secret2fa</code> (le mot de passe et le secret sont optionnels si le compte est deja connu). <strong>A l'enregistrement, seuls les usernames restent affiches</strong> : les identifiants partent dans un fichier serveur (<code>data/snap-accounts.json</code>) qui n'est jamais envoye au navigateur. Le 3e champ est le <strong>secret 2FA</strong> (la cle base32 type <code>HEVQZRQ4UFTIA3BLKD5MEC2HAN4I5PAS</code>), pas le code a 6 chiffres.</p>
      <p class="field-help"><strong>Stock</strong> = au repos. <strong>Reception</strong> = recoivent et acceptent les demandes venant des sites jusqu'a la limite. <strong>Overflow</strong> = a la limite d'acceptation mais acceptent encore (deplaces automatiquement). <strong>Bannis / fermes</strong> = zone terminale.</p>
      <div class="field"><label>Stock (au repos)</label><textarea data-config-path="snapchat.accounts.stock" data-list="lines" rows="5" placeholder="compte1:motdepasse:SECRET2FA&#10;compte2:motdepasse:SECRET2FA">${escapeHtml(s.accounts.stock.join("\n"))}</textarea></div>
      <div class="field"><label>Reception (acceptent jusqu'a la limite)</label><textarea data-config-path="snapchat.accounts.receiving" data-list="lines" rows="5" placeholder="ceryun:motdepasse:SECRET2FA">${escapeHtml(s.accounts.receiving.join("\n"))}</textarea></div>
      <div class="field"><label>Overflow (a la limite, acceptent encore)</label><textarea data-config-path="snapchat.accounts.overflow" data-list="lines" rows="5">${escapeHtml(s.accounts.overflow.join("\n"))}</textarea></div>
      <div class="field">
        <label>Bannis / fermes (${s.accounts.banned.length})</label>
        <textarea data-config-path="snapchat.accounts.banned" data-list="lines" rows="4">${escapeHtml(s.accounts.banned.join("\n"))}</textarea>
        <p class="field-help">Zone <strong>terminale</strong> : ces comptes ne sont plus places, plus provisionnes, et <strong>liberent leur creneau</strong> sur le RDP (${s.accounts.banned.length} creneau${s.accounts.banned.length > 1 ? "x" : ""} rendu${s.accounts.banned.length > 1 ? "s" : ""}). Le demontage y deplace un compte automatiquement ; retirer un username d'ici le remet en circulation.</p>
      </div>
    </div>

    <div class="settings-band" style="max-width:820px;">
      <div class="band-heading"><h2>Liste de cibles (.txt) — ajout d'amis</h2></div>
      <p class="field-help">Usernames a ajouter (un par ligne). Consommee selon « Ajout depuis la liste » et « ajouts avant rotation ».</p>
      <div class="field"><label>Cibles</label><textarea data-config-path="snapchat.targetList" rows="6" placeholder="target_a&#10;target_b">${escapeHtml(s.targetList)}</textarea></div>
    </div>

    <div class="settings-band" style="max-width:820px;">
      <div class="band-heading" style="display:flex;justify-content:space-between;align-items:center;">
        <h2 style="margin:0;">Model setups</h2>
        <button type="button" class="button" id="snap-add-model">+ Ajouter un model</button>
      </div>
      <p class="field-help">Chaque model = un preset (persona IA) + une media vault, et le pool de comptes Snap qui l'utilisent. La plateforme « snap » des URLs pointe vers un de ces models.</p>
    </div>
    ${modelRows || `<div class="settings-band" style="max-width:820px;"><p class="field-help">Aucun model setup. Clique « + Ajouter un model ».</p></div>`}

    <div class="settings-band" style="max-width:820px;">
      <div class="band-heading" style="display:flex;justify-content:space-between;align-items:center;">
        <h2 style="margin:0;">Flotte RDP</h2>
        <button type="button" class="button" id="snap-add-rdp">+ Ajouter un RDP</button>
      </div>
      <p class="field-help">Capacite totale : <strong>${totalLoad} / ${totalCapacity}</strong> instances sur ${s.rdps.length} RDP. Les nouveaux comptes sont places sur le RDP le plus libre, puis debordent sur le suivant.</p>
    </div>
    ${rdpRows || `<div class="settings-band" style="max-width:820px;"><p class="field-help">Aucun RDP. Clique « + Ajouter un RDP ».</p></div>`}

    <div class="settings-band" style="max-width:820px;">
      <div class="band-heading" style="display:flex;justify-content:space-between;align-items:center;">
        <h2 style="margin:0;">Orchestration</h2>
        <div style="display:flex;gap:8px;">
          <button type="button" class="button secondary" id="snap-fleet-refresh">Rafraichir l'etat</button>
          <button type="button" class="button" id="snap-fleet-place">Placer les comptes</button>
        </div>
      </div>
      <p class="field-help">Chaque RDP fait tourner l'agent snap_farm (<code>python -m snap_farm.agent --token …</code>) sur le port configure. « Placer » attribue chaque compte non place au premier RDP qui a de la place, puis deborde sur le suivant. Les mots de passe ne quittent jamais le RDP : le dashboard n'envoie que des usernames, l'agent lit <code>accounts.json</code> en local.</p>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:8px;">
        <input type="checkbox" id="snap-fleet-provision"> Provisionner aussi les instances (clone + identite + proxy + login, plusieurs minutes par compte)
      </label>
      ${fleetSummary}

      <h4 style="margin-top:20px;">Creation de comptes</h4>
      <p class="field-help">Le lot tourne sur le RDP, pas ici. Chaque compte recoit une boite du pool (mot de passe change avant usage) et le code de verification est lu par IMAP — aucun SMS dans la boucle.</p>
      <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;">
        <div class="field" style="margin:0;"><label>Prenom</label><input id="snap-create-first" value="${escapeHtml(s.autoRecreateFirstName || "Lina")}" placeholder="Lina" style="width:140px;"></div>
        <div class="field" style="margin:0;"><label>Combien</label><input id="snap-create-count" type="number" min="1" max="50" value="5" style="width:90px;"></div>
        <button type="button" class="button" id="snap-create-go">Creer</button>
        <button type="button" class="button secondary" id="snap-create-status">Voir l'avancement</button>
      </div>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-top:12px;">
        <input type="checkbox" data-config-path="snapchat.autoRecreate" ${s.autoRecreate ? "checked" : ""}> Recreer automatiquement un compte quand un autre part en zone bannis
      </label>
      <div class="field" style="margin-top:8px;max-width:260px;"><label>Prenom des comptes recrees</label><input data-config-path="snapchat.autoRecreateFirstName" value="${escapeHtml(s.autoRecreateFirstName || "")}" placeholder="vide = celui qui domine la flotte"></div>
      <div id="snap-create-out" class="field-help" style="margin-top:10px;"></div>
    </div>
  `;

  bindConfigControls(container);

  const sortieCreation = () => container.querySelector("#snap-create-out");
  container.querySelector("#snap-create-go")?.addEventListener("click", async () => {
    const firstName = container.querySelector("#snap-create-first")?.value?.trim() || "";
    const count = Number(container.querySelector("#snap-create-count")?.value) || 1;
    const out = sortieCreation();
    out.textContent = "commande en cours...";
    try {
      const r = await api("/api/snap/create", { method: "POST", body: { firstName, count } });
      out.innerHTML = r.alreadyRunning
        ? `Un lot tourne deja sur <strong>${escapeHtml(r.label)}</strong> — commande ignoree.`
        : `<strong>${r.accepted}</strong> compte(s) « ${escapeHtml(r.firstName)} » commande(s) sur <strong>${escapeHtml(r.label)}</strong>. Environ 2 min par compte.`;
    } catch (e) {
      out.innerHTML = `<span style="color:#e74c3c;">${escapeHtml(e.message)}</span>`;
    }
  });
  container.querySelector("#snap-create-status")?.addEventListener("click", async () => {
    const out = sortieCreation();
    out.textContent = "lecture...";
    try {
      const r = await api("/api/snap/create/status");
      const jobs = (r.jobs || []).slice(-3).reverse();
      if (!jobs.length) { out.textContent = r.error ? `agent injoignable: ${r.error}` : "aucune creation lancee."; return; }
      out.innerHTML = jobs.map((j) => {
        const ok = (j.results || []).filter((x) => x.ok);
        const ko = (j.results || []).filter((x) => !x.ok);
        const detail = ok.length ? `<br><span style="opacity:.75;">${ok.map((x) => escapeHtml(x.username) + (x.email ? " → " + escapeHtml(x.email) : "")).join("<br>")}</span>` : "";
        return `<div style="margin-bottom:8px;"><strong>${escapeHtml(j.state)}</strong> · ${j.done}/${j.total} traites · ${ok.length} cree(s), ${ko.length} echec(s)${j.error ? " · " + escapeHtml(j.error) : ""}${detail}</div>`;
      }).join("");
    } catch (e) {
      out.innerHTML = `<span style="color:#e74c3c;">${escapeHtml(e.message)}</span>`;
    }
  });
  container.querySelector("#snap-add-model")?.addEventListener("click", () => {
    s.modelSetups.push({ id: "", name: `Model ${s.modelSetups.length + 1}`, model: "", presetId: presets[0]?.id || "", mediaVaultId: "", accountPool: [] });
    markDirty();
    renderSnapchat();
  });
  container.querySelector("#snap-add-rdp")?.addEventListener("click", () => {
    s.rdps.push({ id: "", label: `RDP ${s.rdps.length + 1}`, host: "", sshPort: 22, user: "root", agentPort: 8799, agentToken: "", os: "windows", ramMb: 0, cpuCores: 0, cpuOvercommit: 2, maxInstances: 0, currentLoad: 0, status: "offline" });
    markDirty();
    renderSnapchat();
  });
  for (const button of container.querySelectorAll("[data-remove-model]")) {
    button.addEventListener("click", () => {
      s.modelSetups.splice(Number(button.dataset.removeModel), 1);
      markDirty();
      renderSnapchat();
    });
  }
  for (const button of container.querySelectorAll("[data-remove-rdp]")) {
    button.addEventListener("click", () => {
      s.rdps.splice(Number(button.dataset.removeRdp), 1);
      markDirty();
      renderSnapchat();
    });
  }

  // Le bandeau "Profils AdsPower existants" et son bouton d'adoption ont ete
  // retires: la flotte tourne sur des profils natifs, plus rien n'est adopte
  // depuis AdsPower. L'endpoint serveur reste en place mais n'est plus expose.
  container.querySelector("#snap-fleet-refresh")?.addEventListener("click", () => {
    loadSnapFleet({ refresh: true, quiet: false });
  });
  container.querySelector("#snap-fleet-place")?.addEventListener("click", async () => {
    if (state.dirty && !confirm("La config n'est pas enregistree. Placer quand meme ?")) return;
    const provision = Boolean(container.querySelector("#snap-fleet-provision")?.checked);
    try {
      const result = await api("/api/snap/place", { method: "POST", body: { provision } });
      state.snapFleet = result.fleet;
      const failed = (result.provisionJobs || []).filter((j) => !j.ok);
      showToast(
        `${result.placed.length} place(s), ${result.skipped.length} deja place(s)`
        + `${result.rejected.length ? `, ${result.rejected.length} sans capacite` : ""}`
        + `${failed.length ? ` — provisionnement refuse par ${failed.length} agent(s)` : ""}`,
        result.rejected.length || failed.length ? "error" : "success",
      );
      renderSnapchat();
    } catch (error) {
      showToast(error.message, "error");
    }
  });
  for (const button of container.querySelectorAll("[data-unplace]")) {
    button.addEventListener("click", async () => {
      const username = button.dataset.unplace;
      try {
        const result = await api("/api/snap/unplace", { method: "POST", body: { usernames: [username] } });
        state.snapFleet = result.fleet;
        showToast(`${username} detache.`);
        renderSnapchat();
      } catch (error) {
        showToast(error.message, "error");
      }
    });
  }

  // Premier affichage: on lit le registre (sans interroger les agents, qui
  // peuvent etre lents ou injoignables — c'est le bouton qui declenche ca).
  if (!state.snapFleet) loadSnapFleet();
}

function setView(view) {
  state.activeView = view;
  for (const section of document.querySelectorAll(".view")) {
    section.hidden = section.id !== `view-${view}`;
  }
  updatePageHeader();
  syncNavigation();
  elements.saveButton.hidden = ["playground", "media", "conversations", "apikeys"].includes(view);
  if (view === "studio") renderStudio();
  if (view === "archives") renderPresetArchives();
  if (view === "media") renderMediaVault();
  if (view === "accounts") {
    state.engineProfiles = null;
    renderAccounts();
  }
  if (view === "omegleweb") renderOmegleweb();
  if (view === "blocked") renderBlockedMessages();
  if (view === "snapchat") renderSnapchat();
  if (view === "apikeys") {
    renderAssistantKeys();
    refreshAssistantKeys();
    renderApiKeysPage();
  } else if (state.assistantUi) {
    // la clé en clair n'est montrée qu'une fois : elle ne survit pas à un changement de page
    state.assistantUi.reveal = null;
  }
  if (view === "playground") renderPlayground();
  if (view === "monitor") loadDashboard({ quiet: true });
  if (view === "conversations") renderConversationsArchive();
}

// --- Vue Conversations (archive persistee) ---
let conversationsArchiveCache = [];
let conversationsArchiveWired = false;
let conversationsArchiveSelected = null;

function formatArchiveDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function renderConversationsArchive() {
  const listEl = document.querySelector("#conversations-archive-list");
  if (!listEl) return;
  if (!conversationsArchiveWired) wireConversationsArchive();
  listEl.innerHTML = "<li class=\"conversations-archive-loading\">Chargement…</li>";
  try {
    const platform = document.getElementById("conversations-archive-platform")?.value || ""; const archiveUrl = "/api/conversations/archive?limit=200" + (platform ? "&platform=" + encodeURIComponent(platform) : ""); const data = await api(archiveUrl);
    conversationsArchiveCache = data.conversations || [];
  } catch (error) {
    listEl.innerHTML = `<li class="conversations-archive-loading">Erreur : ${escapeHtml(error.message)}</li>`;
    return;
  }
  renderConversationsArchiveList();
}

function renderConversationsArchiveList() {
  const listEl = document.querySelector("#conversations-archive-list");
  const countEl = document.querySelector("#conversations-archive-count");
  if (!listEl) return;
  const query = (document.querySelector("#conversations-archive-search")?.value || "").trim().toLowerCase();
  const items = conversationsArchiveCache.filter((it) => !query
    || [it.username, it.partnerId, it.accountId, it.presetId].some((v) => String(v || "").toLowerCase().includes(query)));
  if (countEl) countEl.textContent = `${items.length} conversation${items.length > 1 ? "s" : ""}`;
  if (!items.length) {
    listEl.innerHTML = "<li class=\"conversations-archive-loading\">Aucune conversation.</li>";
    return;
  }
  listEl.innerHTML = items.map((it) => {
    const active = conversationsArchiveSelected
      && conversationsArchiveSelected.accountId === it.accountId
      && conversationsArchiveSelected.partnerId === it.partnerId;
    return `<li><button type="button" class="conversations-archive-item${active ? " active" : ""}" data-account="${escapeHtml(it.accountId)}" data-partner="${escapeHtml(it.partnerId)}">
      <span class="conversations-archive-item-name">${escapeHtml(it.username || it.partnerId)}</span>
      <span class="conversations-archive-item-meta">${escapeHtml(it.accountId)} · ${it.exchanges || 0} éch. · ${formatArchiveDate(it.updatedAt)}</span>
    </button></li>`;
  }).join("");
}

async function selectArchiveConversation(accountId, partnerId) {
  conversationsArchiveSelected = { accountId, partnerId };
  renderConversationsArchiveList();
  const detailEl = document.querySelector("#conversations-archive-detail");
  if (!detailEl) return;
  detailEl.innerHTML = "<p class=\"conversations-archive-empty\">Chargement…</p>";
  let record;
  try {
    record = await api(`/api/conversations/archive/${encodeURIComponent(accountId)}/${encodeURIComponent(partnerId)}`);
  } catch (error) {
    detailEl.innerHTML = `<p class="conversations-archive-empty">Erreur : ${escapeHtml(error.message)}</p>`;
    return;
  }
  const bubbles = (record.messages || []).map((m) => {
    const mine = m.role === "assistant";
    return `<div class="conversations-archive-bubble ${mine ? "me" : "them"}">${escapeHtml(m.content)}</div>`;
  }).join("");
  const lastReply = record.lastReply
    ? `<div class="conversations-archive-bubble me last" title="Dernière réponse IA">${escapeHtml(record.lastReply)}</div>`
    : "";
  detailEl.innerHTML = `<div class="conversations-archive-detail-head">
      <div><strong>${escapeHtml(record.username || record.partnerId)}</strong>
      <span>${escapeHtml(record.accountId)} · ${record.exchanges || 0} échanges · maj ${formatArchiveDate(record.updatedAt)}</span></div>
      <button type="button" class="button ghost" id="conversations-archive-export-one">⤓ .txt</button>
    </div>
    <div class="conversations-archive-thread">${bubbles}${lastReply}</div>`;
  document.querySelector("#conversations-archive-export-one")
    ?.addEventListener("click", () => exportOneConversation(record));
}

function exportOneConversation(record) {
  const lines = [`Conversation ${record.username || record.partnerId} <-> ${record.accountId}`, `maj ${record.updatedAt}`, ""];
  for (const m of record.messages || []) {
    lines.push(`${m.role === "assistant" ? "IA" : (record.username || "Contact")}: ${m.content}`);
  }
  if (record.lastReply) lines.push(`IA: ${record.lastReply}`);
  downloadText(`conversation-${record.accountId}-${record.partnerId}.txt`, lines.join("\n"));
}

async function exportAllConversationsJson() {
  const data = await api("/api/conversations/export");
  downloadJson(`conversations-${new Date().toISOString().slice(0, 10)}.json`, data);
}

async function exportAllConversationsCsv() {
  const data = await api("/api/conversations/export");
  const rows = [["accountId", "presetId", "partnerId", "username", "exchanges", "updatedAt", "lastReply"]];
  for (const c of data.conversations || []) {
    rows.push([c.accountId, c.presetId, c.partnerId, c.username, c.exchanges || 0, c.updatedAt, String(c.lastReply || "").replace(/\s+/g, " ")]);
  }
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? "").replaceAll('"', '""')}"`).join(",")).join("\r\n");
  downloadText(`conversations-${new Date().toISOString().slice(0, 10)}.csv`, csv);
}

function wireConversationsArchive() {
  conversationsArchiveWired = true;
  document.querySelector("#conversations-archive-platform")?.addEventListener("change", () => renderConversationsArchive());
  document.querySelector("#conversations-archive-list")?.addEventListener("click", (event) => {
    const button = event.target.closest(".conversations-archive-item");
    if (!button) return;
    selectArchiveConversation(button.dataset.account, button.dataset.partner);
  });
  document.querySelector("#conversations-archive-search")?.addEventListener("input", () => renderConversationsArchiveList());
  document.querySelector("#conversations-archive-refresh")?.addEventListener("click", () => renderConversationsArchive());
  document.querySelector("#conversations-archive-export")
    ?.addEventListener("click", () => exportAllConversationsJson().catch((e) => showToast(`Export échoué : ${e.message}`, "error")));
  document.querySelector("#conversations-archive-export-csv")
    ?.addEventListener("click", () => exportAllConversationsCsv().catch((e) => showToast(`Export échoué : ${e.message}`, "error")));
}

function randomFourDigitId(existingIds = []) {
  const ids = new Set([...existingIds].map(String));
  for (let attempts = 0; attempts < 200; attempts += 1) {
    const id = String(1000 + Math.floor(Math.random() * 9000));
    if (!ids.has(id)) return id;
  }
  for (let candidate = 1000; candidate <= 9999; candidate += 1) {
    const id = String(candidate);
    if (!ids.has(id)) return id;
  }
  throw new Error("Plus aucun identifiant 4 chiffres disponible.");
}

function uniquePresetId(base) {
  const ids = new Set(configPresets().map((preset) => preset.id));
  return randomFourDigitId(ids);
}

function downloadJson(filename, payload) {
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function exportCurrentPreset() {
  const preset = currentPreset();
  if (!preset) return;
  elements.exportPreset.disabled = true;
  try {
    const payload = await api(`/api/studio/presets/${encodeURIComponent(preset.id)}/export`);
    downloadJson(`${preset.id}.preset.json`, payload);
    showToast("Preset exporte.");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    elements.exportPreset.disabled = false;
  }
}

// Export/import par section (onglet). Doit rester synchro avec
// PRESET_SECTION_MODULES dans src/studio-config.js. "optimizations" est absent
// (audit calcule, aucune donnee editable).
const SECTION_MODULES = {
  main: ["identity", "persona", "style", "strategy", "behavior", "mainSettings"],
  openers: ["openers"],
  phases: ["cycles", "phases"],
  cta: ["ctaScripts"],
  urls: ["urls"],
  objections: ["objections"],
  sprinkles: ["sprinkles"],
  followups: ["followups"],
  finishers: ["finishers"],
  ignorelist: ["ignoreConditions"],
  media: ["media"],
};
const SECTION_LABELS = {
  main: "Main Settings",
  openers: "Openers",
  phases: "Chatting Phases",
  cta: "Call-To-Action",
  urls: "URLs",
  objections: "Objections",
  sprinkles: "Sprinkles",
  followups: "Follow-ups",
  finishers: "Finisher",
  ignorelist: "Ignore condition",
  media: "Media Vault",
};

function sectionIoBar(tab) {
  if (!SECTION_MODULES[tab]) return "";
  const label = SECTION_LABELS[tab] || tab;
  return `
    <div class="section-io">
      <span class="section-io-label">${escapeHtml(label)}</span>
      <button type="button" class="button ghost section-io-btn" data-export-section="${tab}" title="Exporter cette section dans un fichier">Exporter la section</button>
      <button type="button" class="button ghost section-io-btn" data-import-section="${tab}" title="Importer cette section depuis un fichier">Importer la section</button>
    </div>`;
}

function bindSectionIo() {
  const exportBtn = elements.editorContent.querySelector("[data-export-section]");
  if (exportBtn) {
    exportBtn.addEventListener("click", () => exportSection(exportBtn.dataset.exportSection));
  }
  const importBtn = elements.editorContent.querySelector("[data-import-section]");
  if (importBtn) {
    importBtn.addEventListener("click", () => pickSectionFile(importBtn.dataset.importSection));
  }
}

function exportSection(tab) {
  const preset = currentPreset();
  const keys = SECTION_MODULES[tab];
  if (!preset || !keys) return;
  const modules = {};
  for (const key of keys) modules[key] = preset[key];
  const label = SECTION_LABELS[tab] || tab;
  const safeName = String(preset.name || preset.id).replace(/[^a-z0-9._-]+/gi, "-");
  downloadJson(`${safeName}-${tab}.section.json`, {
    format: "bambouai-section",
    version: 1,
    section: tab,
    exportedAt: new Date().toISOString(),
    fromPreset: { id: preset.id, name: preset.name },
    modules,
  });
  showToast(`Section "${label}" exportee.`);
}

function pickSectionFile(tab) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.addEventListener("change", () => {
    importSection(tab, input.files?.[0]);
  });
  input.click();
}

async function importSection(tab, file) {
  if (!file) return;
  const preset = currentPreset();
  if (!preset) return;
  const label = SECTION_LABELS[tab] || tab;
  try {
    const text = await file.text();
    const payload = JSON.parse(text.replace(/^﻿/, ""));
    // Sauve d'abord les modifs en cours: l'import lit la config depuis le
    // disque cote serveur et la reponse ecrase state.config. Si la sauvegarde
    // echoue (saveStudio avale ses erreurs sans lever), state.dirty reste vrai
    // -> on annule pour ne pas perdre les modifs non sauvegardees.
    if (state.dirty) {
      await saveStudio();
      if (state.dirty) throw new Error("Sauvegarde des modifications en cours echouee, import annule.");
    }
    const response = await api(`/api/studio/presets/${encodeURIComponent(preset.id)}/import-section`, {
      method: "POST",
      body: { section: tab, payload },
    });
    const { importedSection, presetId, ...config } = response;
    state.config = config;
    await loadMediaLibrary().catch(() => {});
    markSaved();
    renderStudio();
    showToast(`Section "${label}" importee.`);
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function importPresetFile(file) {
  if (!file) return;
  elements.importPreset.disabled = true;
  try {
    const text = await file.text();
    const payload = JSON.parse(text.replace(/^\uFEFF/, ""));
    const response = await api("/api/studio/presets/import", {
      method: "POST",
      body: { payload },
    });
    const { importedPresetId, ...config } = response;
    state.config = config;
    await loadMediaLibrary().catch(() => {});
    state.selectedPresetId = importedPresetId || configPresets().at(-1)?.id;
    state.editorTab = "main";
    markSaved();
    if (state.activeView === "monitor") {
      renderChatNowAccountSettings();
      await loadDashboard({ quiet: true });
    }
    renderStudio();
    showToast("Preset importe.");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    elements.importPreset.disabled = false;
    elements.presetImportInput.value = "";
  }
}

async function loadStudio() {
  state.config = await api("/api/studio/config");
  await Promise.all([
    loadMediaLibrary().catch(() => {}),
    loadAdspowerProxies(),
    loadMailboxes(),
  ]);
  state.selectedPresetId = configPresets()[0]?.id || null;
  renderStudio();
}

async function saveStudio() {
  elements.saveButton.disabled = true;
  elements.saveButton.textContent = "Enregistrement...";
  try {
    // La cle du moteur part APRES la config : on la verifie avant d'ecrire quoi que ce soit,
    // sinon un refus laisserait le moteur change alors que l'enregistrement est declare en echec.
    const engineKey = state.engineKeyDraft.trim();
    if (state.engineKeyDraft && !(engineKey.length >= 12 && /^[\x21-\x7e]+$/.test(engineKey))) {
      state.engineKeyDraft = "";
      throw new Error("Clé du moteur invalide (12 caractères minimum, sans espace ni saut de ligne) : rien n'a été enregistré.");
    }
    if (state.ollamaKeyDraft !== null) {
      await api("/api/studio/ollama-key", {
        method: "PUT",
        body: { key: state.ollamaKeyDraft },
      });
      state.ollamaKeyDraft = null;
    }
    if (state.visionKeyDraft) {
      await api("/api/studio/vision-key", {
        method: "PUT",
        body: { key: state.visionKeyDraft },
      });
      state.visionKeyDraft = "";
    }
    if (state.fallbackKeyDraft) {
      await api("/api/studio/haiku-key", {
        method: "PUT",
        body: { key: state.fallbackKeyDraft },
      });
      state.fallbackKeyDraft = "";
    }
    state.config = await api("/api/studio/config", {
      method: "PUT",
      body: state.config,
    });
    // La cle du moteur va dans le fichier du fournisseur de l'URL qui vient
    // d'etre enregistree : elle doit donc partir APRES la config.
    if (state.engineKeyDraft) {
      await api("/api/studio/engine-key", {
        method: "PUT",
        body: { key: engineKey },
      });
      state.engineKeyDraft = "";
      state.config.engine.apiKeyConfigured = true;
      await loadEngineProfiles();
    }
    await loadMediaLibrary().catch(() => {});
    markSaved();
    showToast("Configuration enregistrée.");
    return true;
  } catch (error) {
    showToast(error.message, "error");
    return false;
  } finally {
    elements.saveButton.disabled = false;
    elements.saveButton.textContent = "Enregistrer";
  }
}

async function loadOllamaModels() {
  const button = document.querySelector("#load-ollama-models");
  const result = document.querySelector("#ollama-models-result");
  const options = document.querySelector("#ollama-model-options");
  if (!button || !result || !options) return;
  button.disabled = true;
  result.textContent = "Chargement...";
  options.innerHTML = "";
  try {
    if (state.ollamaKeyDraft !== null) {
      if (!(await saveStudio())) throw new Error("Enregistre la clé Ollama avant de charger les modèles.");
    }
    const response = await api("/api/studio/ollama-models", {
      method: "POST",
      body: { baseUrl: state.config.engine.baseUrl },
    });
    options.innerHTML = response.models.map((model) => `<option value="${escapeHtml(model)}"></option>`).join("");
    result.textContent = response.models.length
      ? `${response.models.length} modèle(s) disponible(s). Choisis un nom dans le champ Modèle.`
      : "Aucun modèle installé. Installe un modèle avec ollama pull sur le serveur Ollama, puis recharge la liste.";
  } catch (error) {
    result.textContent = error.message;
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function testEngine() {
  const button = document.querySelector("#test-engine");
  const result = document.querySelector("#engine-test-result");
  if (!button || !result) return;
  button.disabled = true;
  result.textContent = "Connexion...";
  try {
    if (state.dirty && !(await saveStudio())) throw new Error("Enregistrement impossible : le moteur n'a pas été testé.");
    const response = await api("/api/studio/engine-test", { method: "POST" });
    result.textContent = response.model
      ? `Connecté · ${response.model}`
      : "Moteur connecté";
    showToast("Connexion au moteur réussie.");
  } catch (error) {
    result.textContent = error.message;
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

function formatTime(value) {
  if (!value) return "Jamais";
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function accountStatusLabel(account) {
  if (account.discarded) {
    if (account.recreation?.status === "created") return "Remplacement cree";
    if (account.recreation?.status === "pending") return "Recreation...";
    if (account.recreateError) return "Recreation echouee";
    return "Jeté";
  }
  if (account.banned) {
    return account.bannedUntil ? `Banni jusqu'au ${formatTime(account.bannedUntil)}` : "Banni";
  }
  return account.online ? "En ligne" : "Hors ligne";
}

function accountStatusClass(account) {
  if (account.discarded) return "discarded";
  if (account.banned) return "banned";
  return account.online ? "" : "offline";
}

function renderDashboard() {
  const { totals, accounts } = state.dashboard;
  elements.metricOnline.textContent = `${totals.online}/${totals.accounts}`;
  elements.metricConversations.textContent = totals.conversations.toLocaleString("fr-FR");
  elements.metricUnread.textContent = totals.unread.toLocaleString("fr-FR");
  elements.metricPending.textContent = totals.pending.toLocaleString("fr-FR");
  renderChatNowAccountSettings();
  elements.accountList.innerHTML = accounts.map((account) => {
    const liveState = account.discarded
      ? account.recreation?.status === "created"
        ? `Remplacement: ${escapeHtml(account.recreation.accountName || account.replacementAccountName || account.replacementAccountId || "")}`
        : account.recreateError
          ? "Recreation echouee"
          : "Compte jete"
      : account.banned ? "IA en pause" : account.workerRunning ? "IA active" : "IA arretee";
    return `
    <button type="button" class="live-account ${
      state.selectedAccountId === account.id ? "selected" : ""
    }" data-live-account="${escapeHtml(account.id)}">
      <span class="account-avatar">${escapeHtml(account.name[0] || "?")}</span>
      <span class="account-identity">
        <span>
          <strong>${escapeHtml(account.name)}</strong>
          <span>${liveState} · ${account.latencyMs} ms</span>
        </span>
      </span>
      <span class="live-stat"><strong>${account.conversationCount}</strong><span>conversations</span></span>
      <span class="live-stat"><strong>${account.unreadCount}</strong><span>non lus</span></span>
      <span class="online-status ${accountStatusClass(account)}">${escapeHtml(accountStatusLabel(account))}</span>
    </button>
  `;
  }).join("");
  for (const button of elements.accountList.querySelectorAll("[data-live-account]")) {
    button.addEventListener("click", () => selectLiveAccount(button.dataset.liveAccount));
  }
}

function filteredConversations() {
  const query = state.search.trim().toLocaleLowerCase("fr");
  if (!query) return state.conversations;
  return state.conversations.filter((conversation) =>
    conversation.username.toLocaleLowerCase("fr").includes(query)
    || conversation.preview.toLocaleLowerCase("fr").includes(query)
  );
}

function renderConversations() {
  const conversations = filteredConversations();
  elements.conversationCount.textContent = conversations.length;
  if (!conversations.length) {
    elements.conversationList.innerHTML = `<div class="empty-state">Aucune conversation trouvée.</div>`;
    return;
  }
  elements.conversationList.innerHTML = conversations.map((conversation) => `
    <button type="button" class="conversation-item ${conversation.stopped ? "stopped" : ""} ${
      state.selectedConversationId === conversation.partnerId ? "selected" : ""
    }" data-conversation-id="${escapeHtml(conversation.partnerId)}">
      <span class="conversation-avatar">${escapeHtml(conversation.username[0] || "?")}</span>
      <span class="conversation-copy">
        <strong>${escapeHtml(conversation.username)}</strong>
        <span>${escapeHtml(conversation.preview || "Aucun aperçu")}</span>
      </span>
      ${conversation.stopped
        ? `<span class="conversation-stop-pill" title="Conversation arretee par objection ou finisher">Stoppée${conversation.unreadCount > 0 ? ` · ${conversation.unreadCount}` : ""}</span>`
        : conversation.unreadCount > 0
        ? `<span class="conversation-badge">${conversation.unreadCount}</span>`
        : !conversation.lastMessageByMe
          ? `<span class="waiting-dot" title="Attend une réponse"></span>`
          : ""}
    </button>
  `).join("");
  for (const button of elements.conversationList.querySelectorAll("[data-conversation-id]")) {
    button.addEventListener("click", () => openConversation(button.dataset.conversationId));
  }
}

async function loadDashboard({ quiet = false } = {}) {
  if (elements.refreshButton) elements.refreshButton.disabled = true;
  try {
    state.dashboard = await api("/api/dashboard");
    renderDashboard();
    if (!state.selectedAccountId && state.dashboard.accounts.length) {
      await selectLiveAccount(state.dashboard.accounts[0].id);
    }
    if (!quiet) showToast("Supervision actualisée.");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    if (elements.refreshButton) elements.refreshButton.disabled = false;
  }
}

async function selectLiveAccount(accountId) {
  state.selectedAccountId = accountId;
  state.selectedConversationId = null;
  state.search = "";
  elements.conversationSearch.value = "";
  elements.messageView.hidden = true;
  elements.messageEmpty.hidden = false;
  if (state.dashboard) renderDashboard();
  const account = state.dashboard.accounts.find((entry) => entry.id === accountId);
  elements.conversationTitle.textContent = account?.name || "ChatNow";
  elements.conversationList.innerHTML = `<div class="empty-state">Chargement...</div>`;
  try {
    const payload = await api(`/api/accounts/${encodeURIComponent(accountId)}/conversations`);
    state.conversations = payload.conversations;
    renderConversations();
  } catch (error) {
    elements.conversationList.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

async function openConversation(partnerId) {
  state.selectedConversationId = partnerId;
  renderConversations();
  elements.messageEmpty.hidden = true;
  elements.messageView.hidden = false;
  elements.messages.innerHTML = `<div class="empty-state">Chargement...</div>`;
  try {
    const payload = await api(
      `/api/accounts/${encodeURIComponent(state.selectedAccountId)}`
      + `/conversations/${encodeURIComponent(partnerId)}/messages`,
    );
    renderMessages(payload);
  } catch (error) {
    elements.messages.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

function renderMessages(payload) {
  const messages = payload.messages || [];
  elements.partnerName.textContent = payload.partner_username || "Conversation";
  elements.partnerMeta.textContent = `${messages.length} messages · ${payload.account.name}`;
  elements.messages.innerHTML = messages.map((message) => {
    const senderName = message.sender?.username || "Inconnu";
    const own = senderName.toLocaleLowerCase("fr")
      === payload.account.name.toLocaleLowerCase("fr");
    return `
      <article class="message ${own ? "own" : ""}">
        <div class="message-bubble">${escapeHtml(message.content || "[Média]")}</div>
        <div class="message-meta">${escapeHtml(senderName)} · ${escapeHtml(formatTime(message.inserted_at))}</div>
      </article>
    `;
  }).join("") || `<div class="empty-state">Aucun message.</div>`;
  requestAnimationFrame(() => {
    elements.messages.scrollTop = elements.messages.scrollHeight;
  });
}

async function refreshCurrentConversation() {
  if (!state.selectedConversationId) return;
  await openConversation(state.selectedConversationId);
  const payload = await api(
    `/api/accounts/${encodeURIComponent(state.selectedAccountId)}/conversations`,
  );
  state.conversations = payload.conversations;
  renderConversations();
}

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.loginError.textContent = "";
  const submit = elements.loginForm.querySelector("button");
  submit.disabled = true;
  try {
    await api("/api/login", {
      method: "POST",
      body: { key: elements.adminKey.value },
    });
    elements.adminKey.value = "";
    showApp();
    await loadStudio();
    setView("studio");
  } catch (error) {
    elements.loginError.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

elements.logoutButton.addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  showLogin();
});

elements.sidebarLogoutButton?.addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  showLogin();
});

for (const button of document.querySelectorAll("[data-view]")) {
  button.addEventListener("click", () => {
    if (button.dataset.view === "studio" && button.closest(".capital-nav")) {
      state.editorTab = "main";
    }
    setView(button.dataset.view);
  });
}

for (const button of document.querySelectorAll("[data-studio-tab]")) {
  button.addEventListener("click", () => {
    state.editorTab = button.dataset.studioTab;
    setView("studio");
  });
}

for (const button of document.querySelectorAll("[data-toast]")) {
  button.addEventListener("click", () => showToast(button.dataset.toast));
}

elements.mediaPresetSelect?.addEventListener("change", () => {
  state.mediaVaultId = elements.mediaPresetSelect.value;
  state.mediaDayId = currentMediaDays()[0]?.id || null;
  renderMediaVaultSurface();
});

elements.mediaAddVaultButton?.addEventListener("click", async () => {
  const name = window.prompt("Nom du nouveau Media Vault", `Media Vault ${(state.mediaLibrary?.vaults.length || 0) + 1}`);
  if (!name) return;
  try {
    state.mediaLibrary = await api("/api/media/vaults", {
      method: "POST",
      body: { name },
    });
    state.mediaVaultId = state.mediaLibrary.vaults.at(-1)?.id || state.mediaVaultId;
    state.mediaDayId = currentMediaDays()[0]?.id || null;
    renderMediaVaultSurface();
    renderEditor();
    showToast("Media Vault cree.");
  } catch (error) {
    showToast(error.message, "error");
  }
});

elements.mediaRenameVault?.addEventListener("click", async () => {
  const vault = currentMediaVault();
  if (!vault) return;
  const name = window.prompt("Nouveau nom du Media Vault", vault.name);
  if (!name || name === vault.name) return;
  try {
    state.mediaLibrary = await api(`/api/media/vaults/${encodeURIComponent(vault.id)}`, {
      method: "PATCH",
      body: { name },
    });
    renderMediaVaultSurface();
    renderEditor();
    showToast("Media Vault renomme.");
  } catch (error) {
    showToast(error.message, "error");
  }
});

elements.mediaDeleteVault?.addEventListener("click", async () => {
  const vault = currentMediaVault();
  if (!vault) return;
  if (!window.confirm(`Supprimer le Media Vault "${vault.name}" ?`)) return;
  try {
    state.mediaLibrary = await api(`/api/media/vaults/${encodeURIComponent(vault.id)}`, {
      method: "DELETE",
    });
    state.mediaVaultId = state.mediaLibrary.vaults[0]?.id || null;
    state.mediaDayId = currentMediaDays()[0]?.id || null;
    renderMediaVaultSurface();
    renderEditor();
    showToast("Media Vault supprime.");
  } catch (error) {
    showToast(error.message, "error");
  }
});

elements.mediaUploadInput?.addEventListener("change", () => {
  uploadMediaFiles(Array.from(elements.mediaUploadInput.files || []));
});

elements.mediaAddDay?.addEventListener("click", async () => {
  const days = currentMediaDays();
  const name = window.prompt("Nom du jour / outfit", `Outfit Day ${days.length + 1}`);
  if (!name) return;
  try {
    state.mediaLibrary = await api("/api/media/days", {
      method: "POST",
      body: {
        vaultId: state.mediaVaultId,
        name,
      },
    });
    state.mediaDayId = currentMediaDays().at(-1)?.id || state.mediaDayId;
    renderMediaVaultSurface();
    showToast("Jour ajoute.");
  } catch (error) {
    showToast(error.message, "error");
  }
});

for (const button of elements.mediaCategoryTabs?.querySelectorAll("[data-media-category]") || []) {
  button.addEventListener("click", () => {
    state.mediaCategory = button.dataset.mediaCategory;
    renderMediaVaultSurface();
  });
}

for (const button of elements.editorTabs.querySelectorAll("[data-tab]")) {
  button.addEventListener("click", () => {
    state.editorTab = button.dataset.tab;
    renderEditor();
  });
}

elements.presetCtaToggle.addEventListener("change", () => {
  if (!currentPreset()) return;
  currentPreset().strategy.ctaEnabled = elements.presetCtaToggle.checked;
  markDirty();
});

elements.addPreset.addEventListener("click", () => {
  const source = structuredClone(currentPreset() || configPresets()[0]);
  if (!source) return;
  source.archivedAt = null;
  const presets = configPresets();
  const number = presets.length + 1;
  source.id = uniquePresetId(`nouveau-preset-${number}`);
  source.name = `Nouveau preset ${number}`;
  source.identity.name = "Nouveau";
  state.config.presets = [...presets, source];
  state.selectedPresetId = source.id;
  markDirty();
  renderStudio();
});

elements.duplicatePreset.addEventListener("click", () => {
  if (!currentPreset()) return;
  const source = structuredClone(currentPreset());
  source.archivedAt = null;
  const presets = configPresets();
  source.id = uniquePresetId(`${source.id}-copie`);
  source.name = `${source.name} copie`;
  state.config.presets = [...presets, source];
  state.selectedPresetId = source.id;
  markDirty();
  renderStudio();
});

elements.exportPreset?.addEventListener("click", exportCurrentPreset);
elements.importPreset?.addEventListener("click", () => {
  elements.presetImportInput.click();
});
elements.presetImportInput?.addEventListener("change", () => {
  importPresetFile(elements.presetImportInput.files?.[0]);
});

document.getElementById("archive-preset")?.addEventListener("click", () => {
  if (currentPreset()) setPresetArchived(currentPreset().id, true);
});

elements.deletePreset.addEventListener("click", () => {
  if (!currentPreset()) return;
  const presets = configPresets();
  if (presets.length === 1) {
    showToast("Il faut conserver au moins un preset.", "error");
    return;
  }
  if (!window.confirm(`Supprimer le preset "${currentPreset().name}" ?`)) return;
  const removedId = currentPreset().id;
  state.config.presets = presets.filter((preset) => preset.id !== removedId);
  state.selectedPresetId = configPresets()[0]?.id || null;
  for (const account of state.config.accounts) {
    if (account.presetId === removedId) account.presetId = state.selectedPresetId;
  }
  markDirty();
  renderStudio();
});

ensurePlaygroundLayout();

elements.saveButton.addEventListener("click", saveStudio);
for (const tab of document.querySelectorAll("[data-playground-debug]")) {
  tab.addEventListener("click", () => {
    state.playgroundDebugTab = tab.dataset.playgroundDebug;
    renderPlaygroundDebug();
  });
}
elements.playgroundModel?.addEventListener("change", () => {
  state.playgroundMediaVaultId = elements.playgroundModel.value;
  state.playgroundRunId += 1;
  state.playgroundMessages = [];
  state.playgroundStopped = false;
  state.playgroundStopReason = "";
  state.playgroundLastResponse = null;
  state.playgroundLastRequest = buildPlaygroundDebugRequest();
  renderPlaygroundMessages();
  renderPlaygroundDebug();
});
elements.playgroundPreset?.addEventListener("change", () => {
  state.playgroundRunId += 1;
  state.playgroundMessages = [];
  state.playgroundStopped = false;
  state.playgroundStopReason = "";
  state.playgroundLastResponse = null;
  state.playgroundLastRequest = buildPlaygroundDebugRequest();
  renderPlaygroundMessages();
  renderPlaygroundDebug();
});
elements.playgroundImageInput?.addEventListener("change", async () => {
  const file = elements.playgroundImageInput.files?.[0];
  elements.playgroundImageInput.value = "";
  if (!file) return;
  if (state.playgroundStopped) {
    showToast("Conversation arretee. Reset pour relancer un test.", "error");
    return;
  }
  try {
    const imageUrl = await compressPlaygroundImage(file);
    state.playgroundMessages.push({
      role: "user",
      type: "image",
      content: imageUrl,
      imageUrl,
      timestamp: nowTimestampSeconds(),
    });
    state.playgroundLastRequest = buildPlaygroundDebugRequest();
    renderPlaygroundMessages();
    renderPlaygroundDebug();
  } catch (error) {
    showToast(error.message, "error");
  }
});
elements.resetPlayground.addEventListener("click", () => {
  state.playgroundRunId += 1;
  state.playgroundMessages = [];
  state.playgroundLastRequest = null;
  state.playgroundLastResponse = null;
  state.playgroundStopped = false;
  state.playgroundStopReason = "";
  renderPlaygroundMessages();
  renderPlaygroundDebug();
});
elements.playgroundForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.playgroundStopped) {
    showToast("Conversation arretee. Reset pour relancer un test.", "error");
    return;
  }
  const runId = state.playgroundRunId + 1;
  state.playgroundRunId = runId;
  const rawContent = elements.playgroundInput.value.replace(/\r\n/g, "\n");
  const content = rawContent.trim();
  const testOpener = !content && !state.playgroundMessages.length;
  if (!testOpener) {
    state.playgroundMessages.push({
      role: "user",
      content,
      timestamp: nowTimestampSeconds(),
    });
  }
  elements.playgroundInput.value = "";
  const messages = testOpener
    ? [{ role: "user", content: "__BAMBOU_TEST_OPENER__", timestamp: nowTimestampSeconds() }]
    : state.playgroundMessages;
  state.playgroundLastRequest = {
    ...buildPlaygroundDebugRequest(),
    chatHistory: messages.map(playgroundDebugHistoryItem),
  };
  if (testOpener) {
    state.playgroundLastRequest = {
      ...state.playgroundLastRequest,
      testOpener: true,
    };
  }
  state.playgroundLastResponse = { status: "Generating..." };
  renderPlaygroundMessages();
  renderPlaygroundDebug();
  const submit = elements.playgroundForm.querySelector("[type='submit']");
  submit.disabled = true;
  submit.textContent = "...";
  submit.textContent = "Génération...";
  try {
    const response = await api("/api/studio/generate", {
      method: "POST",
      body: {
        presetId: elements.playgroundPreset.value,
        mediaVaultId: state.playgroundMediaVaultId || "",
        messages,
        testOpener,
      },
    });
    state.playgroundLastResponse = response;
    const responseItems = playgroundResponseItems(response);
    for (const [index, item] of responseItems.entries()) {
      await wait(item.delayMs ?? fallbackPlaygroundDelayMs(item));
      if (runId !== state.playgroundRunId) return;
      state.playgroundMessages.push({
        role: "assistant",
        content: item.content,
        type: item.type,
        ...(item.itemId ? { itemId: item.itemId } : {}),
        ...(item.mediaPool ? { mediaPool: item.mediaPool } : {}),
        ...(typeof item.disappearing === "boolean" ? { disappearing: item.disappearing } : {}),
        ...(Number.isFinite(Number(item.delayMs)) ? { delayMs: Number(item.delayMs) } : {}),
        timestamp: nowTimestampSeconds() + index,
      });
      renderPlaygroundMessages();
    }
    if (runId !== state.playgroundRunId) return;
    if (response.stopConversation) {
      state.playgroundStopped = true;
      state.playgroundStopReason = response.debug?.stopReason
        || response.debug?.activeStopSignal?.kind
        || response.debug?.activeObjection?.trigger
        || "stopConversation";
    }
    state.playgroundDebugTab = "response";
    renderPlaygroundMessages();
  } catch (error) {
    state.playgroundLastResponse = { error: error.message };
    state.playgroundDebugTab = "response";
    renderPlaygroundDebug();
    showToast(error.message, "error");
  } finally {
    submit.disabled = false;
    submit.textContent = "S";
  }
});
elements.playgroundInput.addEventListener("keydown", (event) => {
  if (
    event.key !== "Enter"
    || event.shiftKey
    || event.ctrlKey
    || event.altKey
    || event.metaKey
    || event.isComposing
  ) {
    return;
  }
  event.preventDefault();
  const submit = elements.playgroundForm.querySelector("[type='submit']");
  if (submit?.disabled) return;
  if (typeof elements.playgroundForm.requestSubmit === "function") {
    elements.playgroundForm.requestSubmit();
    return;
  }
  elements.playgroundForm.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
});
elements.refreshButton.addEventListener("click", () => loadDashboard());
elements.conversationSearch.addEventListener("input", (event) => {
  state.search = event.target.value;
  renderConversations();
});

elements.replyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const content = elements.replyInput.value.trim();
  if (!content || !state.selectedConversationId) return;
  const submit = elements.replyForm.querySelector("button");
  submit.disabled = true;
  try {
    await api(
      `/api/accounts/${encodeURIComponent(state.selectedAccountId)}`
      + `/conversations/${encodeURIComponent(state.selectedConversationId)}/messages`,
      { method: "POST", body: { content } },
    );
    elements.replyInput.value = "";
    showToast("Message envoyé.");
    await refreshCurrentConversation();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    submit.disabled = false;
  }
});

elements.aiProcessButton.addEventListener("click", async () => {
  if (!state.selectedConversationId) return;
  elements.aiProcessButton.disabled = true;
  elements.aiProcessButton.textContent = "Génération...";
  try {
    await api(
      `/api/accounts/${encodeURIComponent(state.selectedAccountId)}`
      + `/conversations/${encodeURIComponent(state.selectedConversationId)}/process`,
      { method: "POST" },
    );
    showToast("Réponse IA traitée.");
    await refreshCurrentConversation();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    elements.aiProcessButton.disabled = false;
    elements.aiProcessButton.textContent = "Répondre avec l'IA";
  }
});

window.addEventListener("beforeunload", (event) => {
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = "";
});

async function initialize() {
  try {
    const session = await api("/api/session");
    if (!session.authenticated) {
      showLogin();
      return;
    }
    showApp();
    await loadStudio();
    setView("studio");
  } catch {
    showLogin();
  }
}

initialize();

// Memorise l'ouverture des sections repliables. En delegation sur le document:
// les sections sont regenerees a chaque rendu, un listener pose sur l'element
// serait perdu.
document.addEventListener("toggle", (event) => {
  const band = event.target;
  if (!(band instanceof HTMLElement) || !band.matches("details.settings-band[data-band]")) return;
  try {
    localStorage.setItem(`bmb-band-${band.dataset.band}`, band.open ? "1" : "0");
  } catch (_) { /* mode prive: tant pis, l'etat ne survivra pas au rendu */ }
}, true);
