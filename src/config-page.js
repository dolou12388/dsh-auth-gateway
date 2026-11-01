/**
 * 登录后的「模型配置」页。
 *
 * 三步：填 API 地址和 Key → 拉取模型列表 → 选一个默认模型。
 *
 * 全部内联、无 CDN 依赖，和登录页同一套视觉。
 */

/**
 * @param {object} opts
 * @param {string} [opts.baseURL] - 已保存的地址
 * @param {string} [opts.model] - 已保存的默认模型
 * @param {boolean} opts.hasKey - 是否已存过 Key
 * @param {string} [opts.notice] - 顶部提示
 * @param {boolean} [opts.noticeIsError] - 提示是否为错误样式
 * @returns {string}
 */
export function renderConfigPage({ baseURL, model, hasKey, notice, noticeIsError }) {
  const noticeBlock =
    notice === undefined
      ? ""
      : `<div class="${noticeIsError ? "err" : "ok"}" role="status">${escapeHtml(notice)}</div>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>模型配置</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh;
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif;
    background: #f5f5f4; color: #1c1c1a; padding: 32px 20px 64px;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a19; color: #ececeb; }
    .card { background: #232322 !important; border-color: #35343a !important; }
    input, select { background: #1a1a19 !important; color: #ececeb !important; border-color: #45444a !important; }
    .hint, label span { color: #a3a29d !important; }
    .row { border-color: #35343a !important; }
  }
  .wrap { max-width: 620px; margin: 0 auto; }
  .card {
    background: #fff; border: 1px solid #e2e1dc; border-radius: 14px;
    padding: 26px 24px; margin-bottom: 16px;
  }
  h1 { margin: 0 0 6px; font-size: 19px; font-weight: 500; }
  h2 { margin: 0 0 4px; font-size: 15px; font-weight: 500; }
  .hint { margin: 0 0 18px; font-size: 13px; color: #6b6a65; }
  .err, .ok {
    margin: 0 0 16px; padding: 10px 12px; font-size: 13px; border-radius: 8px;
  }
  .err { background: #fcebeb; color: #a32d2d; border: 1px solid #f7c1c1; }
  .ok { background: #eaf6ec; color: #1f6b34; border: 1px solid #bfe3c8; }
  label.f { display: block; margin-bottom: 16px; }
  label.f span { display: block; margin-bottom: 6px; font-size: 13px; color: #6b6a65; }
  input, select {
    width: 100%; padding: 10px 12px; font-size: 15px;
    border: 1px solid #d3d1c7; border-radius: 8px; background: #fff;
    font-family: inherit;
  }
  input:focus, select:focus { outline: 2px solid #378add; outline-offset: -1px; border-color: #378add; }
  button {
    padding: 10px 18px; font-size: 14px; font-weight: 500; cursor: pointer;
    border-radius: 8px; border: 1px solid transparent;
  }
  .primary { color: #fff; background: #1c1c1a; }
  .primary:hover { opacity: .88; }
  .secondary { color: #1c1c1a; background: #fff; border-color: #d3d1c7; }
  .secondary:hover { background: #faf9f7; }
  button:disabled { opacity: .45; cursor: default; }
  .actions { display: flex; gap: 10px; align-items: center; margin-top: 4px; flex-wrap: wrap; }
  .status { font-size: 13px; color: #6b6a65; }
  .row {
    display: flex; justify-content: space-between; gap: 12px;
    padding: 10px 0; border-bottom: 1px solid #eeede8; font-size: 13px;
  }
  .row:last-child { border-bottom: 0; }
  .row b { font-weight: 500; }
  .muted { color: #8a8983; }
  code {
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    background: #f0efea; padding: 1px 5px; border-radius: 4px;
  }
  @media (prefers-color-scheme: dark) { code { background: #2f2f2e; } }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>模型配置</h1>
    <p class="hint">填好 API 地址和 Key 后拉取模型列表，选一个作为默认模型。保存后立即生效，不用重启 DSH。</p>
    ${noticeBlock}

    <label class="f">
      <span>API 地址（Base URL）</span>
      <input id="baseURL" type="url" placeholder="https://api.example.com/v1"
             value="${escapeHtml(baseURL ?? "")}" autocomplete="off" spellcheck="false">
    </label>

    <label class="f">
      <span>API Key${hasKey ? "（已保存，留空表示不修改）" : ""}</span>
      <input id="apiKey" type="password" placeholder="${hasKey ? "••••••••（保持原值请留空）" : "sk-..."}"
             autocomplete="off" spellcheck="false">
    </label>

    <div class="actions">
      <button id="fetchBtn" class="secondary" type="button">拉取模型列表</button>
      <span id="fetchStatus" class="status"></span>
    </div>
  </div>

  <div class="card">
    <h2>默认模型</h2>
    <p class="hint">先拉取列表，或直接填入模型 id。</p>
    <label class="f">
      <span>模型</span>
      <select id="modelSelect" style="display:none"></select>
      <input id="modelInput" type="text" placeholder="deepseek-v4-1-flash"
             value="${escapeHtml(model ?? "")}" autocomplete="off" spellcheck="false">
    </label>
    <div class="actions">
      <button id="saveBtn" class="primary" type="button">保存并生效</button>
      <a href="/" style="font-size:13px">返回 DSH</a>
      <span id="saveStatus" class="status"></span>
    </div>
  </div>

  <div class="card">
    <h2>当前状态</h2>
    <div class="row"><span class="muted">API 地址</span><b id="curBase">${baseURL === undefined ? "未配置" : escapeHtml(baseURL)}</b></div>
    <div class="row"><span class="muted">默认模型</span><b id="curModel">${model === undefined ? "未配置" : escapeHtml(model)}</b></div>
    <div class="row"><span class="muted">API Key</span><b>${hasKey ? "已保存" : "未配置"}</b></div>
  </div>
</div>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var fetchBtn = $('fetchBtn'), saveBtn = $('saveBtn');
  var fetchStatus = $('fetchStatus'), saveStatus = $('saveStatus');
  var select = $('modelSelect'), input = $('modelInput');

  function say(el, text, isErr) {
    el.textContent = text;
    el.style.color = isErr ? '#a32d2d' : '#6b6a65';
  }

  fetchBtn.addEventListener('click', function () {
    var baseURL = $('baseURL').value.trim();
    var apiKey = $('apiKey').value;
    if (baseURL === '') { say(fetchStatus, '请先填 API 地址', true); return; }
    fetchBtn.disabled = true;
    say(fetchStatus, '正在拉取…', false);

    fetch('/__gateway/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseURL: baseURL, apiKey: apiKey })
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) { say(fetchStatus, res.j.error || '拉取失败', true); return; }
        var models = res.j.models || [];
        if (models.length === 0) { say(fetchStatus, '上游没有返回任何模型', true); return; }
        say(fetchStatus, '拉到 ' + models.length + ' 个模型', false);
        select.innerHTML = '';
        models.forEach(function (id) {
          var o = document.createElement('option');
          o.value = id; o.textContent = id;
          select.appendChild(o);
        });
        select.style.display = 'block';
        input.style.display = 'none';
        // 如果已保存的模型在列表里，选中它
        var cur = input.value;
        if (cur && models.indexOf(cur) !== -1) select.value = cur;
      })
      .catch(function (e) { say(fetchStatus, '请求出错：' + e.message, true); })
      .finally(function () { fetchBtn.disabled = false; });
  });

  saveBtn.addEventListener('click', function () {
    var baseURL = $('baseURL').value.trim();
    var apiKey = $('apiKey').value;
    var model = select.style.display === 'block' ? select.value : input.value.trim();
    if (baseURL === '') { say(saveStatus, '请填 API 地址', true); return; }
    if (model === '') { say(saveStatus, '请选择或填写模型', true); return; }

    saveBtn.disabled = true;
    say(saveStatus, '正在保存…', false);

    fetch('/__gateway/save-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseURL: baseURL, apiKey: apiKey, model: model })
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) { say(saveStatus, res.j.error || '保存失败', true); return; }
        say(saveStatus, '已保存，正在跳转…', false);
        setTimeout(function () { location.href = '/'; }, 700);
      })
      .catch(function (e) { say(saveStatus, '请求出错：' + e.message, true); })
      .finally(function () { saveBtn.disabled = false; });
  });
})();
</script>
</body>
</html>`;
}

/**
 * @param {string} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
