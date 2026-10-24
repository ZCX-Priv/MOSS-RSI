// browser-extension/popup.js
// 扩展弹窗：显示桥接状态，编辑端口/令牌/自动连接。

'use strict';

const $ = (id) => document.getElementById(id);

function setStatus(status) {
  if (!status) return;
  const dot = $('status-dot');
  const text = $('status-text');
  if (status.connected) {
    dot.className = 'dot on';
    text.textContent = `已连接 MOSS（端口 ${status.port}）`;
  } else {
    dot.className = 'dot off';
    text.textContent = status.autoConnect ? '未连接，正在自动重试…' : '自动连接已关闭';
  }
  $('port').value = String(status.configuredPort || 7799);
  $('auto').checked = status.autoConnect !== false;
  const detail = [];
  detail.push(`扩展 v${status.extensionVersion}`);
  if (status.instanceId) detail.push(`实例 ${String(status.instanceId).slice(0, 8)}`);
  if (status.tokenConfigured) detail.push('已配置令牌');
  $('detail').textContent = detail.join(' · ');
}

async function refresh() {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'moss:getStatus' });
    setStatus(status);
    if (status && status.tokenConfigured) {
      $('token').placeholder = '已配置（留空保持不变）';
    }
  } catch {
    $('status-text').textContent = '无法读取扩展状态';
  }
}

async function save() {
  const port = Number($('port').value);
  if (!Number.isFinite(port) || port < 1024 || port > 65535) {
    $('status-text').textContent = '端口必须在 1024-65535 之间';
    return;
  }
  const tokenInput = $('token').value;
  const payload = {
    type: 'moss:saveSettings',
    port,
    autoConnect: $('auto').checked,
  };
  // 留空 = 不修改已保存的令牌
  if (tokenInput) payload.token = tokenInput;
  await chrome.runtime.sendMessage(payload);
  $('token').value = '';
  setTimeout(refresh, 600);
}

$('save').addEventListener('click', () => void save());
$('reconnect').addEventListener('click', async () => {
  $('status-text').textContent = '正在重连…';
  await chrome.runtime.sendMessage({ type: 'moss:reconnect' });
  setTimeout(refresh, 600);
});
$('disconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'moss:disconnect' });
  setTimeout(refresh, 300);
});

void refresh();
setInterval(refresh, 2000);
