/* 리쿠르팅 소개 고치기 (2026-09-28 사용자: 「랜딩페이지를 내가 계속 고칠 수 있게」)
   총관리자가 발표 화면 그대로 보면서 글을 누르면 그 자리에서 고치고, 사진은 눌러서 바꾼다.
   저장하면 서버(page_edits)로 가고 직전 판이 남는다. 저장소 원본 HTML은 건드리지 않는다.
   고칠 수 있는 칸 = data-k 표식이 붙은 칸 (server/tools/mark-edit-keys.py 가 붙인다). */
(function () {
  var PAGE = 'recruit';
  var API = new URL('../', location.href).href;
  var token = ''; try { token = localStorage.getItem('ob_token') || ''; } catch (e) { token = ''; }
  var BASE = window.__PAGE_BASE || {};
  var saved = JSON.parse(JSON.stringify(window.__PAGE_EDITS || {}));   // 서버에 있는 것
  var pending = {};                                                    // 이번에 바꾼 것 — k → {html}|{src}|null(원래대로)
  var on = true;                                                       // 누르면 고침 / 누르면 이동
  var editingEl = null;

  function api(p, o) {
    o = o || {};
    var h = { Authorization: 'Bearer ' + token };
    if (o.json !== undefined) h['Content-Type'] = 'application/json';
    else if (o.type) h['Content-Type'] = o.type;
    return fetch(API + p, { method: o.method || 'GET', headers: h, body: o.json !== undefined ? JSON.stringify(o.json) : o.body })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw new Error(j.error || ('오류 ' + r.status));
          return j;
        });
      });
  }

  // ── 모양 ──
  var css = document.createElement('style');
  css.textContent = [
    '.pe-bar{position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:2147483000;display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px 8px;border-radius:10px;background:#111827;color:#fff;font:600 14px/1.2 Pretendard,system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.35);max-width:calc(100vw - 20px)}',
    '.pe-bar b{padding:0 6px;color:#FDE68A}',
    '.pe-bar button{height:34px;padding:0 12px;border:1px solid rgba(255,255,255,.28);border-radius:7px;background:transparent;color:#fff;font:inherit;cursor:pointer}',
    '.pe-bar button:hover{background:rgba(255,255,255,.12)}',
    '.pe-bar button.pe-main{background:#FACC15;border-color:#FACC15;color:#111827}',
    '.pe-bar button.pe-main:disabled{opacity:.45;cursor:default}',
    '.pe-bar button.pe-onoff.off{background:#374151}',
    '.pe-msg{padding:0 6px;color:#A7F3D0;font-weight:500}',
    'body.pe-on [data-k]{outline:1px dashed rgba(250,204,21,.75);outline-offset:3px;cursor:text}',
    'body.pe-on img[data-k]{cursor:pointer}',
    'body.pe-on [data-k].pe-changed{outline:2px solid #22C55E}',
    'body.pe-on [data-k].pe-editing{outline:2px solid #FACC15;background:rgba(250,204,21,.12)}',
    'body.pe-off [data-k]{outline:none;cursor:auto}',
    /* 막대 높이만큼 갈래 화면을 내린다 — 폰·패드에서 막대가 갈래 머리(탭·닫기)를 덮었다 */
    'body.pe-mode .deck{top:var(--pe-h,60px)}',
    '@media(max-width:760px){.pe-bar{top:6px;left:6px;right:6px;transform:none;max-width:none;gap:4px;padding:5px;font-size:13px}.pe-bar>b{display:none}.pe-bar button{height:32px;padding:0 9px}.pe-msg{flex-basis:100%;font-size:12px;padding:0 4px}}',
    '.pe-panel{position:fixed;left:50%;top:var(--pe-h,62px);transform:translateX(-50%);z-index:2147483000;width:min(720px,calc(100vw - 20px));max-height:calc(100vh - 90px);overflow:auto;padding:14px;border-radius:10px;background:#fff;color:#111827;font:500 14px/1.5 Pretendard,system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.35)}',
    '.pe-panel h3{margin:0 0 10px;font-size:16px}',
    '.pe-panel .pe-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid #E5E7EB}',
    '.pe-panel .pe-row:first-of-type{border-top:0}',
    '.pe-panel img{width:96px;height:64px;object-fit:cover;border-radius:6px;background:#F3F4F6}',
    '.pe-panel button{height:32px;padding:0 12px;border:1px solid #D1D5DB;border-radius:7px;background:#fff;font:inherit;cursor:pointer}',
    '.pe-panel button.pe-main{background:#111827;color:#fff;border-color:#111827}',
    '.pe-panel .pe-grow{flex:1;min-width:0}',
    '.pe-panel .pe-sub{color:#6B7280;font-size:13px}',
    '.pe-pop{position:fixed;z-index:2147483001;width:min(420px,calc(100vw - 20px));padding:12px;border-radius:10px;background:#fff;color:#111827;box-shadow:0 12px 40px rgba(0,0,0,.35);font:500 14px/1.4 Pretendard,system-ui,sans-serif}',
    '.pe-pop textarea{width:100%;min-height:72px;box-sizing:border-box;padding:8px;border:1px solid #D1D5DB;border-radius:7px;font:inherit;resize:vertical}',
    '.pe-pop .pe-acts{display:flex;justify-content:flex-end;gap:6px;margin-top:8px}',
    '.pe-pop button{height:32px;padding:0 12px;border:1px solid #D1D5DB;border-radius:7px;background:#fff;font:inherit;cursor:pointer}',
    '.pe-pop button.pe-main{background:#111827;color:#fff;border-color:#111827}'
  ].join('\n');
  document.head.appendChild(css);

  var bar = document.createElement('div');
  bar.className = 'pe-bar';
  bar.innerHTML = '<b>고치기</b><span class="pe-msg" id="peMsg">확인하는 중…</span>';
  document.body.appendChild(bar);
  function msg(t) { var m = bar.querySelector('#peMsg'); if (m) m.textContent = t || ''; }

  // 총관리자인지 서버에 묻는다 — 화면 단추는 앱이 띄웠지만 저장 권한은 서버가 정한다
  api('bootstrap').then(function (b) {
    if (!b.me || !b.me.isSuper) throw new Error('총관리자만 고칠 수 있습니다');
    start();
  }).catch(function (e) {
    msg(e.message || '로그인이 필요합니다');
    var x = document.createElement('button'); x.textContent = '닫기';
    x.onclick = function () { location.search = ''; };
    bar.appendChild(x);
  });

  function start() {
    document.body.classList.add('pe-on', 'pe-mode');
    var fit = function () { document.documentElement.style.setProperty('--pe-h', (bar.getBoundingClientRect().bottom + 8) + 'px'); };
    if (window.ResizeObserver) new ResizeObserver(fit).observe(bar);
    addEventListener('resize', fit);
    bar.innerHTML = '<b>고치기</b>'
      + '<button type="button" class="pe-onoff" id="peOnoff" title="끄면 화면을 평소처럼 넘길 수 있습니다">누르면 고침</button>'
      + '<button type="button" id="pePhotos">사진 바꾸기</button>'
      + '<button type="button" id="peHist">판 기록</button>'
      + '<button type="button" class="pe-main" id="peSave" disabled>저장</button>'
      + '<button type="button" id="peDone">끝내기</button>'
      + '<span class="pe-msg" id="peMsg">글을 누르면 그 자리에서 고칩니다</span>';
    bar.querySelector('#peOnoff').onclick = toggle;
    bar.querySelector('#pePhotos').onclick = photosPanel;
    bar.querySelector('#peHist').onclick = historyPanel;
    bar.querySelector('#peSave').onclick = save;
    bar.querySelector('#peDone').onclick = done;
    requestAnimationFrame(function () { document.documentElement.style.setProperty('--pe-h', (bar.getBoundingClientRect().bottom + 8) + 'px'); });
    Object.keys(saved).forEach(function (k) { var el = byKey(k); if (el) el.classList.add('pe-changed'); });
    refreshCount();
  }
  function byKey(k) { return document.querySelector('[data-k="' + k + '"]'); }
  function toggle() {
    on = !on;
    finishEdit();
    document.body.classList.toggle('pe-on', on);
    document.body.classList.toggle('pe-off', !on);
    var b = bar.querySelector('#peOnoff');
    b.textContent = on ? '누르면 고침' : '누르면 이동';
    b.classList.toggle('off', !on);
    msg(on ? '글을 누르면 그 자리에서 고칩니다' : '화면을 넘겨 고칠 곳으로 가세요. 다시 「누르면 이동」을 누르면 고치기로 돌아옵니다');
  }
  function count() { return Object.keys(pending).length; }
  function refreshCount() {
    var n = count(), b = bar.querySelector('#peSave');
    if (!b) return;
    b.disabled = !n;
    b.textContent = n ? '저장 (' + n + '곳)' : '저장';
  }

  // ── 글을 깨끗이 — 화면이 덧붙인 것(단어 조각·서명 이름·스타일)을 벗긴다 ──
  var ALLOW = { BR: 1, B: 1, STRONG: 1, EM: 1, I: 1, MARK: 1, SMALL: 1, SPAN: 1 };
  var ME_DEFAULT = {};   // 보여주는 사람 자리의 원래 글 — 저장할 때 이 글로 되돌려 둔다(화면이 다시 채운다)
  Object.keys(BASE).forEach(function (k) {
    if (typeof BASE[k] !== 'string' || BASE[k].indexOf('data-me') < 0) return;
    var t = document.createElement('div'); t.innerHTML = BASE[k];
    t.querySelectorAll('[data-me]').forEach(function (s) { if (!(s.dataset.me in ME_DEFAULT)) ME_DEFAULT[s.dataset.me] = s.textContent; });
  });
  function cleanNode(root) {
    [].slice.call(root.querySelectorAll('*')).reverse().forEach(function (n) {
      if (n.tagName === 'SPAN' && n.classList.contains('w')) { n.replaceWith(document.createTextNode(n.textContent)); return; }
      if (!ALLOW[n.tagName]) { n.replaceWith.apply(n, [].slice.call(n.childNodes)); return; }
      var me = n.getAttribute('data-me');
      [].slice.call(n.attributes).forEach(function (a) { n.removeAttribute(a.name); });
      if (me && n.tagName === 'SPAN') { n.setAttribute('data-me', me); n.textContent = ME_DEFAULT[me] || ''; }
    });
    root.normalize();
    return root.innerHTML.replace(/&nbsp;/g, ' ').replace(/(<br>\s*)+$/, '').trim();
  }
  function cleanHtml(h) { var t = document.createElement('div'); t.innerHTML = h; return cleanNode(t); }
  function cleanEl(el) { return cleanNode(el.cloneNode(true)); }
  var norm = function (s) { return String(s || '').replace(/\s+/g, ' ').trim(); };

  // 바뀐 것을 기록한다 — 원본과 같아지면 「원래대로」, 서버에 있는 것과 같으면 기록에서 뺀다
  function record(k, val) {
    var base = BASE[k], isImg = byKey(k) && byKey(k).tagName === 'IMG';
    var want = isImg
      ? (val === base ? null : { src: val })
      : (norm(val) === norm(cleanHtml(base || '')) ? null : { html: val });
    var cur = saved[k] || null;
    var same = want === null ? cur === null : (cur && (isImg ? cur.src === want.src : norm(cur.html) === norm(want.html)));
    if (same) delete pending[k]; else pending[k] = want;
    var el = byKey(k);
    if (el) el.classList.toggle('pe-changed', want !== null);
    refreshCount();
  }

  // ── 누르기 ──
  document.addEventListener('click', function (e) {
    if (!on || e.target.closest('.pe-bar, .pe-panel, .pe-pop')) return;
    var el = e.target.closest('[data-k]');
    if (!el) { if (editingEl && !editingEl.contains(e.target)) finishEdit(); return; }
    e.stopPropagation();                       // 화면 넘김·카드 열기가 같이 일어나지 않게
    if (el === editingEl) return;              // 고치는 중인 칸 안에서 커서 옮기기
    e.preventDefault();
    if (el.tagName === 'IMG') { pickImage(el); return; }
    // 단추 안의 글은 그 자리에서 고치기가 어렵다(단추가 커서를 먹는다) — 작은 창으로 고친다
    if (el.tagName === 'BUTTON' || el.closest('button')) { popEdit(el); return; }
    startEdit(el, e);
  }, true);
  // 화면의 넘김 단축키(방향키·스페이스·F)가 글 치는 손을 가로채지 않게
  window.addEventListener('keydown', function (e) {
    if (!editingEl || !editingEl.contains(e.target)) return;
    e.stopPropagation();
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); document.execCommand('insertLineBreak'); }
    if (e.key === 'Escape') { e.preventDefault(); finishEdit(); }
  }, true);
  document.addEventListener('paste', function (e) {
    if (!editingEl || !editingEl.contains(e.target)) return;
    e.preventDefault();                        // 붙여넣기는 글자만 — 다른 곳의 글꼴·색이 섞이지 않게
    var t = (e.clipboardData || window.clipboardData).getData('text');
    document.execCommand('insertText', false, t);
  }, true);

  function startEdit(el, e) {
    finishEdit();
    editingEl = el;
    el.classList.add('pe-editing');
    el.contentEditable = 'true';
    el.spellcheck = false;
    el.focus();
    if (document.activeElement !== el) { finishEdit(); return; }   // 가려진 칸 — 고치는 중으로 남겨 두면 다음 누르기를 먹는다
    var r = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
    if (r && el.contains(r.startContainer)) { var s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    el.addEventListener('blur', finishEdit, { once: true });
    msg('다 고쳤으면 다른 곳을 누르거나 Esc. 줄 바꿈은 Enter');
  }
  function finishEdit() {
    var el = editingEl;
    if (!el) return;
    editingEl = null;
    el.contentEditable = 'false';
    el.removeAttribute('contenteditable');
    el.classList.remove('pe-editing');
    record(el.getAttribute('data-k'), cleanEl(el));
    msg(count() ? '저장하지 않은 고침 ' + count() + '곳' : '글을 누르면 그 자리에서 고칩니다');
  }

  // 단추 글 고치기 — 줄 바꿈은 Enter, 꾸밈은 없다
  function popEdit(el) {
    finishEdit(); closePops();
    var r = el.getBoundingClientRect();
    var p = document.createElement('div'); p.className = 'pe-pop';
    p.style.left = Math.max(10, Math.min(r.left, innerWidth - 440)) + 'px';
    p.style.top = Math.min(r.bottom + 8, innerHeight - 180) + 'px';
    var text = cleanEl(el).replace(/<br>/g, '\n').replace(/<[^>]+>/g, '');
    var ta = document.createElement('textarea'); ta.value = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    p.appendChild(ta);
    var acts = document.createElement('div'); acts.className = 'pe-acts';
    acts.innerHTML = '<button type="button" data-a="x">그만</button><button type="button" class="pe-main" data-a="ok">바꾸기</button>';
    p.appendChild(acts);
    document.body.appendChild(p);
    ta.focus(); ta.select();
    ta.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Escape') p.remove(); });
    acts.onclick = function (e) {
      var a = e.target.dataset.a; if (!a) return;
      if (a === 'ok') {
        var d = document.createElement('div');
        ta.value.split('\n').forEach(function (line, i) { if (i) d.appendChild(document.createElement('br')); d.appendChild(document.createTextNode(line)); });
        el.innerHTML = d.innerHTML;
        record(el.getAttribute('data-k'), cleanNode(d));
        msg('저장하지 않은 고침 ' + count() + '곳');
      }
      p.remove();
    };
  }

  // ── 사진 ──
  function shrink(file) {
    // 폰 사진은 크다 — 긴 변 2400px 로 줄인다. 로고처럼 작은 PNG 는 그대로(투명 배경을 지킨다)
    return new Promise(function (resolve) {
      if (file.size < 1.5e6) { resolve(file); return; }
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var k = Math.min(1, 2400 / Math.max(img.width, img.height));
        var c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        c.toBlob(function (b) { resolve(b || file); }, 'image/jpeg', 0.86);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }
  function pickImage(el, after) {
    var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/jpeg,image/png,image/webp';
    inp.onchange = function () {
      var f = inp.files && inp.files[0]; if (!f) return;
      msg('사진 올리는 중…');
      shrink(f).then(function (b) { return api('pages/' + PAGE + '/upload', { method: 'POST', body: b, type: b.type || 'application/octet-stream' }); })
        .then(function (out) {
          el.removeAttribute('onerror'); el.hidden = false; el.setAttribute('src', out.src);
          record(el.getAttribute('data-k'), out.src);
          msg('사진을 바꿨습니다 — 저장해야 남습니다');
          if (after) after();
        }).catch(function (e) { msg(e.message); });
    };
    inp.click();
  }
  function closePops() { document.querySelectorAll('.pe-panel, .pe-pop').forEach(function (x) { x.remove(); }); }
  function panel(title) {
    closePops();
    var p = document.createElement('div'); p.className = 'pe-panel';
    p.innerHTML = '<div class="pe-row" style="border:0;padding-top:0"><h3 class="pe-grow" style="margin:0">' + title + '</h3><button type="button" data-a="close">닫기</button></div><div class="pe-body"></div>';
    p.querySelector('[data-a="close"]').onclick = function () { p.remove(); };
    document.body.appendChild(p);
    return p.querySelector('.pe-body');
  }
  // 배경 사진은 글 뒤에 깔려 누를 수가 없다 — 목록에서 바꾼다
  function photosPanel() {
    var body = panel('사진 바꾸기');
    function draw() {
      body.innerHTML = '';
      document.querySelectorAll('img[data-k]').forEach(function (img) {
        var k = img.getAttribute('data-k'), row = document.createElement('div'); row.className = 'pe-row';
        var where = img.closest('[data-stop]'), label = img.getAttribute('alt') || (img.closest('[aria-hidden]') ? '배경 사진' : '사진');
        row.innerHTML = '<img alt=""><div class="pe-grow"><div>' + label + '</div><div class="pe-sub">' + (where ? where.dataset.stop : '') + ' · ' + k + '</div></div>'
          + '<button type="button" class="pe-main" data-a="pick">바꾸기</button>'
          + (img.getAttribute('src') !== BASE[k] ? '<button type="button" data-a="back">원래 사진</button>' : '');
        row.querySelector('img').src = img.currentSrc || img.src;
        row.querySelector('[data-a="pick"]').onclick = function () { pickImage(img, draw); };
        var back = row.querySelector('[data-a="back"]');
        if (back) back.onclick = function () { img.setAttribute('src', BASE[k]); record(k, BASE[k]); draw(); };
        body.appendChild(row);
      });
    }
    draw();
  }
  function historyPanel() {
    var body = panel('판 기록');
    body.innerHTML = '<p class="pe-sub">불러오는 중…</p>';
    api('pages/' + PAGE + '/edits').then(function (d) {
      body.innerHTML = '<p class="pe-sub" style="margin:0 0 8px">저장할 때마다 직전 판이 남습니다. 지금 판: '
        + (d.updated ? d.updated.slice(0, 16).replace('T', ' ') + ' · ' + (d.by_name || '') : '고친 것 없음') + ' · 고친 칸 ' + Object.keys(d.edits || {}).length + '곳</p>';
      if (!d.versions.length) body.innerHTML += '<p class="pe-sub">아직 남은 판이 없습니다.</p>';
      d.versions.forEach(function (v) {
        var row = document.createElement('div'); row.className = 'pe-row';
        row.innerHTML = '<div class="pe-grow">' + v.created.slice(0, 16).replace('T', ' ') + ' 까지의 판<div class="pe-sub">' + (v.by_name || '') + ' · 고친 칸 ' + v.n + '곳</div></div><button type="button">이 판으로 되살리기</button>';
        row.querySelector('button').onclick = function () {
          if (count() && !confirm('저장하지 않은 고침 ' + count() + '곳은 버려집니다. 되살릴까요?')) return;
          api('pages/' + PAGE + '/restore', { method: 'POST', json: { id: v.id } }).then(function () { pending = {}; location.reload(); }).catch(function (e) { msg(e.message); });
        };
        body.appendChild(row);
      });
      var reset = document.createElement('div'); reset.className = 'pe-row';
      reset.innerHTML = '<div class="pe-grow">처음 글로<div class="pe-sub">고친 것을 모두 걷어 냅니다. 지금 판은 기록에 남습니다.</div></div><button type="button">처음 글로</button>';
      reset.querySelector('button').onclick = function () {
        if (!confirm('고친 것을 모두 걷어 내고 처음 글로 돌릴까요? 지금 판은 기록에 남습니다.')) return;
        api('pages/' + PAGE + '/edits', { method: 'POST', json: { edits: {} } }).then(function () { pending = {}; location.reload(); }).catch(function (e) { msg(e.message); });
      };
      body.appendChild(reset);
    }).catch(function (e) { body.innerHTML = '<p class="pe-sub">' + e.message + '</p>'; });
  }

  function save() {
    finishEdit();
    if (!count()) return;
    var next = JSON.parse(JSON.stringify(saved));
    Object.keys(pending).forEach(function (k) { if (pending[k] === null) delete next[k]; else next[k] = pending[k]; });
    var b = bar.querySelector('#peSave'); b.disabled = true;
    msg('저장하는 중…');
    api('pages/' + PAGE + '/edits', { method: 'POST', json: { edits: next } }).then(function (out) {
      saved = out.edits || next; pending = {};
      refreshCount();
      msg('저장했습니다 — 다음에 여는 사람부터 바뀐 글이 보입니다');
    }).catch(function (e) { refreshCount(); msg('저장하지 못했습니다: ' + e.message); });
  }
  function done() {
    finishEdit();
    if (count() && !confirm('저장하지 않은 고침 ' + count() + '곳이 있습니다. 버리고 끝낼까요?')) return;
    pending = {};
    location.search = '';
  }
  window.addEventListener('beforeunload', function (e) { if (count()) { e.preventDefault(); e.returnValue = ''; } });
})();
