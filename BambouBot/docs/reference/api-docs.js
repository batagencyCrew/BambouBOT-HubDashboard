const base = location.origin;
const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let spec;
let endpoints = [];
let noticeTimer;
function announce(text) {
  $('notice').textContent = text;
  $('notice').classList.add('visible');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => $('notice').classList.remove('visible'), 2200);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); announce('Copié.'); }
  catch { announce('Sélectionne le texte pour le copier.'); }
}
function block(text, label) {
  return '<div class="codebox"><div class="codebar"><span>' + escape(label) + '</span><button type="button" data-copy>Copier</button></div><pre><code>' + escape(text) + '</code></pre></div>';
}
document.addEventListener('click', event => {
  const button = event.target.closest('[data-copy]');
  if (button) copy(button.closest('.codebox').querySelector('code').textContent);
});
$('base-url').textContent = base;
$('space-label').textContent = location.hostname === 'pablo.bambouaibot.com' ? 'Espace de Pablo' : 'Espace principal';
document.title = 'Documentation API — ' + (location.hostname === 'pablo.bambouaibot.com' ? 'Pablo' : 'BambouAI');
$('copy-base').addEventListener('click', () => copy(base));
$('quickstart').innerHTML = block([
  'export BAMBOU_API_KEY="VOTRE_CLE_API"',
  '',
  'curl --fail-with-body "' + base + '/api/extension/config" \\',
  '  -H "X-Bambou-Extension-Key: $BAMBOU_API_KEY"',
  '',
  '# Génération : remplace REMPLACER_PAR_ID_DU_PRESET par un id lu ci-dessus',
  'curl --fail-with-body -X POST "' + base + '/api/extension/generate" \\',
  '  -H "X-Bambou-Extension-Key: $BAMBOU_API_KEY" \\',
  '  -H "Content-Type: application/json" \\',
  '  --data \'{"presetId":"REMPLACER_PAR_ID_DU_PRESET","messages":[{"role":"user","content":"Bonjour, comment vas-tu ?"}]}\''
].join('\n'), 'cURL · lecture des presets puis génération');
document.querySelectorAll('.base-url-inline').forEach(node => { node.textContent = base; });
$('session-example').innerHTML = block([
  'curl --fail-with-body -c bambou-cookies.txt \\',
  '  "' + base + '/api/login" \\',
  '  -H "Content-Type: application/json" \\',
  '  --data \'{"key":"VOTRE_CLE_DE_CONNEXION"}\'',
  '',
  'curl --fail-with-body -b bambou-cookies.txt \\',
  '  "' + base + '/api/studio/config"'
].join('\n'), 'cURL · connexion puis lecture de la configuration');
$('archive-example').innerHTML = block([
  'import os',
  'from datetime import datetime, timezone',
  'import requests',
  '',
  'base = ' + JSON.stringify(base),
  'preset_id = "REMPLACER_PAR_ID_DU_PRESET"',
  'archiver = True  # False pour restaurer',
  '',
  'with requests.Session() as session:',
  '    login = session.post(base + "/api/login",',
  '        json={"key": os.environ["BAMBOU_LOGIN_KEY"]}, timeout=30)',
  '    if not login.ok:',
  '        raise SystemExit(str(login.status_code) + " " + login.text)',
  '    response = session.get(base + "/api/studio/config", timeout=30)',
  '    if not response.ok:',
  '        raise SystemExit(str(response.status_code) + " " + response.text)',
  '    config = response.json()',
  '    preset = next(p for p in config["presets"] if p["id"] == preset_id)',
  '    preset["archivedAt"] = (',
  '        datetime.now(timezone.utc).isoformat() if archiver else None)',
  '    saved = session.put(base + "/api/studio/config", json=config, timeout=30)',
  '    if not saved.ok:',
  '        raise SystemExit(str(saved.status_code) + " " + saved.text)',
  '    print("Preset archivé." if archiver else "Preset restauré.")'
].join('\n'), 'Python · modification de archivedAt');

$('assistant-example').innerHTML = block([
  'export BAMBOU_ASSISTANT_KEY="bbk_VOTRE_CLE_ASSISTANT"',
  '',
  '# 1. Presets utilisables avec cette clé',
  'curl --fail-with-body "' + base + '/api/assistant/presets" \\',
  '  -H "Authorization: Bearer $BAMBOU_ASSISTANT_KEY"',
  '',
  '# 2. Génération : remplace REMPLACER_PAR_ID_DU_PRESET par un id lu ci-dessus',
  'curl --fail-with-body -X POST "' + base + '/api/assistant/generate" \\',
  '  -H "Authorization: Bearer $BAMBOU_ASSISTANT_KEY" \\',
  '  -H "Content-Type: application/json" \\',
  '  --data \'{"presetId":"REMPLACER_PAR_ID_DU_PRESET","messages":[{"role":"user","content":"Salut, ça va ?"}]}\''
].join('\n'), 'cURL · assistant : presets puis génération') + block([
  'import os',
  'import requests',
  '',
  'base = ' + JSON.stringify(base),
  'headers = {"Authorization": "Bearer " + os.environ["BAMBOU_ASSISTANT_KEY"]}',
  '',
  'presets = requests.get(base + "/api/assistant/presets", headers=headers, timeout=30)',
  'if not presets.ok:',
  '    raise SystemExit(str(presets.status_code) + " " + presets.text)',
  'preset_id = presets.json()["presets"][0]["id"]',
  '',
  'history = [{"role": "user", "content": "Salut, ça va ?"}]',
  'reply = requests.post(base + "/api/assistant/generate", headers=headers,',
  '    json={"presetId": preset_id, "messages": history}, timeout=150)',
  'if not reply.ok:',
  '    raise SystemExit(str(reply.status_code) + " " + reply.text)',
  'data = reply.json()',
  'print(data["contentText"])',
  '',
  '# Pour continuer : ajoute la réponse puis le message suivant, et renvoie TOUT l\'historique',
  'if not data["stopConversation"]:',
  '    history.append({"role": "assistant", "content": data["contentText"]})',
  '    history.append({"role": "user", "content": "Tu fais quoi ce soir ?"})'
].join('\n'), 'Python · assistant : conversation en plusieurs tours');

function resolve(value) {
  if (!value?.$ref) return value || {};
  return value.$ref.slice(2).split('/').reduce((obj, key) => obj?.[key], spec) || {};
}
function authFor(operation) {
  if (operation.security?.some(s => s.AssistantBearer || s.AssistantKeyHeader)) return 'assistant';
  if (operation.security?.some(s => s.ExtensionKey)) return 'extension';
  if (operation.security?.some(s => s.StudioSession)) return 'session';
  return 'public';
}
function authLabel(auth) {
  return {extension:'Clé API',assistant:'Clé assistant',session:'Session studio',public:'Public'}[auth];
}
function sample(endpoint, language) {
  const {route, method, operation} = endpoint;
  const auth = authFor(operation);
  const url = base + route.replace(/\{([^}]+)\}/g, (_, key) => 'REMPLACER_' + key);
  const body = operation.requestBody?.content?.['application/json']?.example;
  const file = operation['x-request-file'];
  const binary = Boolean(operation.responses?.['200']?.content?.['application/octet-stream']);
  if (language === 'curl') {
    const lines = ['curl --fail-with-body -X ' + method.toUpperCase() + ' "' + url + '"'];
    if (auth === 'extension') lines.push('  -H "X-Bambou-Extension-Key: $BAMBOU_API_KEY"');
    if (auth === 'assistant') lines.push('  -H "Authorization: Bearer $BAMBOU_ASSISTANT_KEY"');
    if (auth === 'session') lines.push('  -b bambou-cookies.txt');
    if (route === '/api/login') lines.push('  -c bambou-cookies.txt');
    if (body || file) {
      lines.push('  -H "Content-Type: application/json"');
      lines.push(file ? '  --data-binary @' + file : "  --data '" + JSON.stringify(body).replace(/'/g, "'\\''") + "'");
    }
    if (binary) lines.push('  --output media.bin');
    return lines.join(' \\\n');
  }
  if (language === 'python') {
    const lines = ['import os', 'import json', 'from pathlib import Path', 'import requests', '', 'base = ' + JSON.stringify(base), 'session = requests.Session()'];
    if (auth === 'session') lines.push('login = session.post(base + "/api/login",', '    json={"key": os.environ["BAMBOU_LOGIN_KEY"]}, timeout=30)', 'if not login.ok:', '    raise SystemExit(str(login.status_code) + " " + login.text)');
    if (auth === 'extension') lines.push('session.headers["X-Bambou-Extension-Key"] = os.environ["BAMBOU_API_KEY"]');
    if (auth === 'assistant') lines.push('session.headers["Authorization"] = "Bearer " + os.environ["BAMBOU_ASSISTANT_KEY"]');
    if (file) lines.push('body = json.loads(Path(' + JSON.stringify(file) + ').read_text(encoding="utf-8"))');
    else if (body) {
      lines.push('body = json.loads(' + JSON.stringify(JSON.stringify(body)) + ')');
      if (route === '/api/login') lines.push('body["key"] = os.environ["BAMBOU_LOGIN_KEY"]');
    }
    lines.push('', 'response = session.request(' + JSON.stringify(method.toUpperCase()) + ', ' + JSON.stringify(url) + (body || file ? ',\n    json=body' : '') + ', timeout=180)  # à augmenter si le délai du moteur dépasse 90 s', 'if not response.ok:', '    raise SystemExit(str(response.status_code) + " " + response.text)');
    lines.push(binary ? 'Path("media.bin").write_bytes(response.content)' : 'print(response.json())');
    return lines.join('\n');
  }
  const lines = ['// Node.js 18+ ; enregistrer dans un fichier .mjs'];
  if (file || binary) lines.push('import { readFile, writeFile } from "node:fs/promises";');
  lines.push('const base = ' + JSON.stringify(base) + ';', 'const headers = {};');
  if (auth === 'session') lines.push(
    'if (!process.env.BAMBOU_LOGIN_KEY) throw new Error("BAMBOU_LOGIN_KEY manquante");',
    'const login = await fetch(base + "/api/login", {',
    '  method: "POST", headers: {"Content-Type": "application/json"},',
    '  body: JSON.stringify({key: process.env.BAMBOU_LOGIN_KEY})',
    '});',
    'if (!login.ok) throw new Error(await login.text());',
    'headers.Cookie = login.headers.get("set-cookie").split(";")[0];'
  );
  if (auth === 'extension') lines.push('if (!process.env.BAMBOU_API_KEY) throw new Error("BAMBOU_API_KEY manquante");', 'headers["X-Bambou-Extension-Key"] = process.env.BAMBOU_API_KEY;');
  if (auth === 'assistant') lines.push('if (!process.env.BAMBOU_ASSISTANT_KEY) throw new Error("BAMBOU_ASSISTANT_KEY manquante");', 'headers.Authorization = "Bearer " + process.env.BAMBOU_ASSISTANT_KEY;');
  if (body || file) {
    lines.push('headers["Content-Type"] = "application/json";');
    lines.push(file ? 'const body = JSON.parse(await readFile(' + JSON.stringify(file) + ', "utf8"));' : 'const body = ' + JSON.stringify(body, null, 2) + ';');
    if (route === '/api/login') lines.push('body.key = process.env.BAMBOU_LOGIN_KEY;');
  }
  lines.push('const response = await fetch(' + JSON.stringify(url) + ', {', '  method: ' + JSON.stringify(method.toUpperCase()) + ', headers,', ...(body || file ? ['  body: JSON.stringify(body),'] : []), '  signal: AbortSignal.timeout(180000) // à augmenter si le délai du moteur dépasse 90 s', '});', 'if (!response.ok) throw new Error(response.status + " " + await response.text());');
  lines.push(binary ? 'await writeFile("media.bin", Buffer.from(await response.arrayBuffer()));' : 'console.log(await response.json());');
  return lines.join('\n');
}
function fields(schema, prefix = '', depth = 0) {
  schema = resolve(schema);
  let rows = '';
  for (const [name, raw] of Object.entries(schema.properties || {})) {
    const item = resolve(raw);
    const key = prefix + name;
    const required = schema.required?.includes(name);
    rows += '<tr><td><code>' + escape(key) + '</code>' + (required ? '<small>obligatoire</small>' : '') + '</td><td>' + escape(item.type || 'objet') + (item.nullable ? ' / null' : '') + '</td><td>' + escape(item.description || '') + (item.enum ? ' Valeurs : ' + escape(item.enum.join(', ')) + '.' : '') + '</td></tr>';
    if (depth < 2) rows += fields(item.type === 'array' ? item.items : item, key + (item.type === 'array' ? '[].' : '.'), depth + 1);
  }
  return rows;
}
function fieldTable(schema) {
  const rows = fields(schema);
  return rows ? '<div class="table-wrap"><table><thead><tr><th>Champ</th><th>Type</th><th>Description</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '';
}
function render() {
  const search = $('search').value.toLocaleLowerCase('fr');
  const category = $('category').value;
  const language = $('language').value;
  const expanded = new Set([...document.querySelectorAll('.endpoint[open]')].map(el => el.id));
  const filtered = endpoints.filter(e => (!category || e.operation.tags?.includes(category)) && (e.method + ' ' + e.route + ' ' + e.operation.summary + ' ' + e.operation.description).toLocaleLowerCase('fr').includes(search));
  $('route-count').textContent = filtered.length + ' opérations sur ' + endpoints.length + ' · exemples à adapter avec tes identifiants';
  $('routes').innerHTML = filtered.map(endpoint => {
    const {route, method, operation, id} = endpoint;
    const auth = authFor(operation);
    const request = operation.requestBody?.content?.['application/json'];
    const response = resolve(operation.responses?.['200']);
    const responseJson = response.content?.['application/json'];
    const params = (operation.parameters || []).map(resolve);
    return '<details class="endpoint" id="' + id + '"' + (expanded.has(id) ? ' open' : '') + '><summary><span class="method ' + method + '">' + method.toUpperCase() + '</span><code class="route-path">' + escape(route) + '</code><span class="endpoint-title">' + escape(operation.summary) + '</span></summary><div class="endpoint-body"><span class="badge ' + auth + '">' + authLabel(auth) + '</span><p>' + escape(operation.description || operation.summary) + '</p>'
      + (params.length ? '<h3>Paramètres</h3><div class="table-wrap"><table><thead><tr><th>Nom</th><th>Emplacement</th><th>Description</th></tr></thead><tbody>' + params.map(p => '<tr><td><code>' + escape(p.name) + '</code>' + (p.required ? '<small>obligatoire</small>' : '') + '</td><td>' + escape(p.in) + '</td><td>' + escape(p.description || '') + (p.schema?.default !== undefined ? ' Défaut : ' + escape(p.schema.default) + '.' : '') + '</td></tr>').join('') + '</tbody></table></div>' : '')
      + (request ? '<h3>Corps JSON</h3>' + fieldTable(request.schema) + (operation['x-request-file'] ? '<p>Fichier complet à préparer : <code>' + escape(operation['x-request-file']) + '</code>.</p>' : '') : '')
      + block(sample(endpoint, language), {curl:'cURL · Bash / zsh / WSL',python:'Python',javascript:'JavaScript · Node.js'}[language])
      + '<h3>Réponse</h3><p>' + escape(response.description) + '</p>'
      + (responseJson?.example ? block(JSON.stringify(responseJson.example, null, 2), 'JSON · exemple illustratif') : '')
      + (responseJson?.schema ? fieldTable(responseJson.schema) : '')
      + '<p class="muted">Codes documentés : ' + Object.keys(operation.responses).map(code => code === 'default' ? 'autres codes selon la cause (400, 402, 413, 429, 500, 502, 503, 504)' : escape(code)).join(', ') + '. Voir « Erreurs et limites » pour leur traitement.</p></div></details>';
  }).join('') || '<p class="empty">Aucune route ne correspond à cette recherche.</p>';
}
try {
  const response = await fetch('/openapi.json');
  if (!response.ok) throw new Error('HTTP ' + response.status);
  spec = await response.json();
  for (const [route, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) endpoints.push({route,method,operation,id:'route-' + endpoints.length});
  }
  for (const tag of spec.tags) {
    const option = document.createElement('option'); option.value = option.textContent = tag.name; $('category').append(option);
  }
  $('search').addEventListener('input', render);
  $('category').addEventListener('change', render);
  $('language').addEventListener('change', render);
  render();
} catch (error) {
  $('routes').textContent = 'La référence ne peut pas être chargée (' + error.message + '). Recharge la page ou télécharge le fichier OpenAPI.';
}
