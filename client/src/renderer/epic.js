(function () {
  const root = document.getElementById('epic-panel');
  if (!root || !window.nexel) return;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  };

  const render = (state) => {
    root.innerHTML = '';

    if (state.linked) {
      root.append(el('div', 'epic-label', `Linked: ${state.displayName || state.accountId}`));
      const out = el('button', 'act', 'Unlink');
      out.onclick = async () => {
        await window.nexel.epicLogout();
        render({});
      };
      root.append(out);
      return;
    }

    if (state.step === 'code') {
      root.append(el('div', 'epic-label', 'Log in on the page that just opened, then paste the code below.'));
      const input = el('input');
      input.type = 'text';
      input.id = 'epic-code';
      input.placeholder = '{"code":"..."} or just the code';
      const go = el('button', 'act', 'Connect');
      const msg = el('div', 'msg');

      go.onclick = async () => {
        go.disabled = true;
        msg.textContent = 'Checking…';
        const r = await window.nexel.epicFinish(input.value);
        if (!r.ok) {
          msg.textContent = r.detail || r.reason;
          msg.className = 'msg bad';
          go.disabled = false;
          return;
        }
        render({ linked: true, displayName: r.displayName, accountId: r.accountId });
      };

      const row = el('div', 'row');
      row.append(input, go);
      root.append(row, msg);
      input.focus();
      return;
    }

    root.append(el('div', 'epic-label', 'Not linked. The game needs an Epic login to boot.'));
    const start = el('button', 'act', 'Get code');
    const msg = el('div', 'msg');
    start.onclick = async () => {
      start.disabled = true;
      const r = await window.nexel.epicStart();
      if (!r.ok) {
        msg.textContent = r.reason;
        msg.className = 'msg bad';
        start.disabled = false;
        return;
      }
      render({ step: 'code' });
    };
    const row = el('div', 'row');
    row.append(start);
    root.append(row, msg);
  };

  window.nexel.epicStatus().then((s) => render(s.linked ? s : {}));
})();
