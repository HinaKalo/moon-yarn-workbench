export function loginPage(destination, message) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · Moon Yarn 工作台</title>
<link rel="stylesheet" href="/assets/style.css"></head><body class="login-page"><main class="login-card">
<div class="login-intro"><p class="wordmark">MOON / YARN</p><h1>剧情工作台</h1><p>写 Yarn 脚本，试跑选项和变量。</p>
${message ? `<p class="notice" role="alert">${message}</p>` : ""}
<a class="primary" href="/auth/start?next=${encodeURIComponent(destination)}">使用 Moon SSO 登录</a></div>
<pre aria-label="Yarn 脚本示例"><span>title:</span> Start
<span>---</span>
档案馆的铁门锁着。
<span>-&gt;</span> 拿起发条钥匙
    <span>&lt;&lt;jump Door&gt;&gt;</span>
<span>-&gt;</span> 离开档案馆
<span>===</span></pre></main></body></html>`;
}
