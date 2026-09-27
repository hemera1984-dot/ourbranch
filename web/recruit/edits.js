/* 저장된 고치기를 입힌다 (2026-09-28).
   서버가 랜딩을 내줄 때 window.__PAGE_EDITS 를 이 파일 바로 앞에 넣는다. 다른 스크립트보다 먼저 돈다 —
   제목 단어 쪼개기·서명 채우기가 고친 글 위에서 일어나야 하기 때문이다. */
(function () {
  var E = window.__PAGE_EDITS || {}, BASE = {};
  document.querySelectorAll('[data-k]').forEach(function (el) {
    var k = el.getAttribute('data-k'), v = E[k];
    BASE[k] = el.tagName === 'IMG' ? el.getAttribute('src') : el.innerHTML;   // 저장소 원본 — 고치기 화면이 견준다
    if (!v) return;
    if (el.tagName === 'IMG') { if (v.src) { el.removeAttribute('onerror'); el.setAttribute('src', v.src); } }
    else if (typeof v.html === 'string') el.innerHTML = v.html;
  });
  window.__PAGE_BASE = BASE;

  var editing = /[?&]edit=1(&|$)/.test(location.search);
  if (editing) {
    var s = document.createElement('script'); s.src = 'editor.js'; document.body.appendChild(s);
    return;
  }
  // 「고치기」 단추 — 앱에서 총관리자가 열었을 때만 조작 바에 붙는다. 저장 권한은 서버가 다시 본다.
  var me = null;
  try { me = window.parent !== window ? window.parent.OB_RECRUIT_ME : null; } catch (e) { me = null; }
  if (!me) try { me = JSON.parse(sessionStorage.getItem('ob_recruit_me') || 'null'); } catch (e) { me = null; }
  var dock = document.getElementById('dock');
  if (me && me.canEdit && dock) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'd-edit'; b.title = '글·사진 고치기';
    b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z M13 7l4 4"/></svg><span>고치기</span>';
    b.addEventListener('click', function () { location.search = '?edit=1'; });
    dock.insertBefore(b, dock.firstChild);
  }
})();
