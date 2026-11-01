/**
 * 登录页 HTML。
 *
 * 刻意做成单文件内联样式脚本：网关要在断网/内网环境可用，
 * 不能依赖任何 CDN 字体或前端框架。
 */

/**
 * 渲染登录页。
 *
 * @param {object} opts
 * @param {boolean} opts.setupMode - true 表示首次设置密码，false 表示输入密码
 * @param {string} [opts.error] - 错误提示
 * @param {string} [opts.next] - 登录后跳转路径
 * @param {number} opts.minLength - 密码最小长度
 * @returns {string} 完整 HTML
 */
export function renderLoginPage({ setupMode, error, next, minLength }) {
  const title = setupMode ? "设置访问密码" : "登录";
  const hint = setupMode
    ? `首次使用，请为这个网关设置一个密码（至少 ${minLength} 位）。密码只保存在本机。`
    : "输入密码以继续。";
  const submitLabel = setupMode ? "设置并进入" : "登录";

  const errorBlock =
    error === undefined
      ? ""
      : `<div class="err" role="alert">${escapeHtml(error)}</div>`;

  // 首次设置需要两次输入，避免手误设成自己不知道的密码后彻底进不去
  const confirmField = setupMode
    ? `<label class="f">
        <span>确认密码</span>
        <input type="password" name="confirm" autocomplete="new-password" required>
      </label>`
    : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif;
    background: #f5f5f4; color: #1c1c1a; padding: 24px;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a19; color: #ececeb; }
    .card { background: #232322 !important; border-color: #35343a !important; }
    input { background: #1a1a19 !important; color: #ececeb !important; border-color: #45444a !important; }
    .hint { color: #a3a29d !important; }
  }
  .card {
    width: 100%; max-width: 380px; background: #fff;
    border: 1px solid #e2e1dc; border-radius: 14px; padding: 28px 26px;
  }
  h1 { margin: 0 0 6px; font-size: 18px; font-weight: 500; }
  .hint { margin: 0 0 20px; font-size: 13px; color: #6b6a65; }
  .err {
    margin: 0 0 16px; padding: 10px 12px; font-size: 13px;
    background: #fcebeb; color: #a32d2d; border-radius: 8px;
    border: 1px solid #f7c1c1;
  }
  label.f { display: block; margin-bottom: 14px; }
  label.f span { display: block; margin-bottom: 6px; font-size: 13px; color: #6b6a65; }
  input {
    width: 100%; padding: 10px 12px; font-size: 15px;
    border: 1px solid #d3d1c7; border-radius: 8px; background: #fff;
  }
  input:focus { outline: 2px solid #378add; outline-offset: -1px; border-color: #378add; }
  button {
    width: 100%; margin-top: 6px; padding: 11px;
    font-size: 15px; font-weight: 500; cursor: pointer;
    color: #fff; background: #1c1c1a; border: 0; border-radius: 8px;
  }
  button:hover { opacity: .88; }
  button:disabled { opacity: .5; cursor: default; }
</style>
</head>
<body>
  <form class="card" method="POST" action="/__gateway/login">
    <h1>${title}</h1>
    <p class="hint">${hint}</p>
    ${errorBlock}
    <input type="hidden" name="next" value="${escapeHtml(next ?? "/")}">
    <label class="f">
      <span>密码</span>
      <input type="password" name="password" autocomplete="${setupMode ? "new-password" : "current-password"}"
             minlength="${minLength}" required autofocus>
    </label>
    ${confirmField}
    <button type="submit">${submitLabel}</button>
  </form>
</body>
</html>`;
}

/**
 * 渲染一个简单的提示页（用于错误或成功信息）。
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.message
 * @param {string} [opts.linkHref]
 * @param {string} [opts.linkText]
 * @returns {string}
 */
export function renderMessagePage({ title, message, linkHref, linkText }) {
  const link =
    linkHref === undefined
      ? ""
      : `<p style="margin:16px 0 0"><a href="${escapeHtml(linkHref)}">${escapeHtml(linkText ?? "继续")}</a></p>`;
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif;
         background:#f5f5f4; color:#1c1c1a; padding:24px; }
  .card { max-width:420px; background:#fff; border:1px solid #e2e1dc;
          border-radius:14px; padding:28px 26px; }
  h1 { margin:0 0 10px; font-size:17px; font-weight:500; }
  p { margin:0; font-size:14px; color:#3c3c3a; }
  a { color:#185fa5; }
  @media (prefers-color-scheme: dark) {
    body { background:#1a1a19; color:#ececeb; }
    .card { background:#232322; border-color:#35343a; }
    p { color:#c8c7c2; }
    a { color:#85b7eb; }
  }
</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${link}</div></body></html>`;
}

/**
 * HTML 转义，防止把用户输入回显进页面造成 XSS。
 *
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
