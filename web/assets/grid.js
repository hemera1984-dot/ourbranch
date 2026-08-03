// 엑셀형 그리드 — 이 프로젝트의 존재 이유는 "작성이 아주아주 편할 것"이다.
// 셀 클릭 편집, Tab/Enter 이동(마지막 줄에서 Enter면 새 줄), 엑셀 여러 줄 붙여넣기.
// 프레임워크 없음. 데이터는 rows 배열을 직접 들고 있고 저장은 호출부가 한다.

"use strict";

function makeGrid(root, opts) {
  // opts: { cols: [{key, label, num?, width?, opts?: [..], sticky?: true}], rows: [{...,_id?}],
  //         canEditRow(row) -> bool,
  //         opts: 정해진 값은 치지 않고 고른다 (칸을 누르면 칩이 뜬다).
  //         sticky: 마지막에 넣은 값을 기억해 새 줄에 미리 채운다.
  //         memoryKey: sticky 값을 저장할 이름 (화면마다 따로 기억한다),
  //         rowClass(row) -> string — 줄 전체에 붙일 클래스 (TA 일지 주의 표시 등),
  //         fixed: {key: value} — 새 줄에 자동으로 박는 값, onDeleteRow(row) }
  //
  // 같은 root에 다시 만들 때 옛 리스너가 남으면 삭제·저장이 여러 번 실행된다.
  // 노드를 새로 갈아끼워 이전 그리드의 리스너를 통째로 버린다.
  if (root._gridBound) {
    var fresh = root.cloneNode(false);
    root.parentNode.replaceChild(fresh, root);
    root = fresh;
  }
  root._gridBound = true;
  var cols = opts.cols;
  var rows = opts.rows.slice();
  var dirty = new Set();     // 수정된 기존 행 (_id 있는 것)
  var added = new Set();     // 새 행 (객체 참조)

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // 날짜 정규화 — 시트에서 복사하면 8/1, 2026. 8. 1, 8월 1일 같은 모양으로 들어온다.
  // 그대로 두면 저장은 되지만 월 조회에서 빠져 "저장했는데 사라졌다"가 된다.
  function normDate(v) {
    var s = String(v == null ? "" : v).trim();
    if (!s) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    var nums = s.match(/\d+/g);
    if (!nums) return s;                                   // 숫자가 없으면 손대지 않는다
    var y, mo, d;
    if (nums.length >= 3) { y = +nums[0]; mo = +nums[1]; d = +nums[2]; }
    else if (nums.length === 2) {                          // 8/1 — 연도는 그리드가 보는 연도로
      y = opts.year || new Date().getFullYear(); mo = +nums[0]; d = +nums[1];
    } else return s;
    if (y < 100) y += 2000;
    if (!(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return s;
    return y + "-" + String(mo).padStart(2, "0") + "-" + String(d).padStart(2, "0");
  }

  function render() {
    var h = ['<div class="grid-wrap"><table class="grid"><thead><tr>'];
    cols.forEach(function (c) { h.push("<th" + (c.width ? ' style="min-width:' + c.width + 'px"' : "") + ">" + esc(c.label) + "</th>"); });
    h.push("<th></th></tr></thead><tbody>");
    rows.forEach(function (r, ri) {
      var editable = opts.canEditRow ? opts.canEditRow(r) : true;
      var cls = [dirty.has(r._id) || added.has(r) ? "dirty" : "", opts.rowClass ? opts.rowClass(r) : ""]
        .filter(Boolean).join(" ");
      h.push('<tr data-ri="' + ri + '"' + (cls ? ' class="' + cls + '"' : "") + ">");
      cols.forEach(function (c, ci) {
        var v = esc(r[c.key]);
        if (!editable) h.push('<td class="ro' + (c.num ? " num" : "") + '">' + v + "</td>");
        else h.push('<td contenteditable="plaintext-only" data-ci="' + ci + '"' + (c.num ? ' class="num"' : "") + ">" + v + "</td>");
      });
      h.push(editable ? '<td class="ro row-del" title="줄 삭제" style="cursor:pointer;text-align:center">&times;</td>' : '<td class="ro"></td>');
      h.push("</tr>");
    });
    h.push("</tbody></table></div>");
    root.innerHTML = h.join("");
  }

  // ── 고르는 칸 ──
  // 성별·단계처럼 값이 정해진 칸은 치지 않고 고른다. 타이핑도 그대로 된다.
  function closeChips() {
    var old = document.querySelector(".grid-chips");
    if (old) old.remove();
  }

  function openChips(td, col) {
    closeChips();
    var col = Object.assign({}, col, { opts: typeof col.opts === "function" ? col.opts() : col.opts });
    if (!col.opts || !col.opts.length) return;
    var box = document.createElement("div");
    box.className = "grid-chips";
    var cur = td.innerText.split(",").map(function (x) { return x.trim(); }).filter(Boolean);
    box.innerHTML = col.opts.map(function (o) {
      return '<button type="button" class="gchip' + (cur.indexOf(o) >= 0 ? " on" : "") + '">' + esc(o) + "</button>";
    }).join("") + '<button type="button" class="gchip clear">지우기</button>';
    document.body.appendChild(box);
    var r = td.getBoundingClientRect();
    box.style.left = Math.max(6, Math.min(r.left + window.scrollX,
      window.scrollX + document.documentElement.clientWidth - box.offsetWidth - 6)) + "px";
    box.style.top = (r.bottom + window.scrollY + 2) + "px";
    box.addEventListener("mousedown", function (e) {
      var b = e.target.closest(".gchip");
      if (!b) return;
      e.preventDefault();                     // 칸의 포커스를 뺏지 않는다
      if (b.classList.contains("clear")) {
        td.innerText = "";
        box.querySelectorAll(".gchip.on").forEach(function (x) { x.classList.remove("on"); });
        commitCell(td);
        if (!col.multi) closeChips();
        return;
      }
      if (col.multi) {
        // 면접관처럼 여럿 고르는 칸 — 창을 열어둔 채로 켜고 끈다
        b.classList.toggle("on");
        td.innerText = [].map.call(box.querySelectorAll(".gchip.on"), function (x) { return x.textContent; }).join(", ");
        commitCell(td);
        return;
      }
      td.innerText = b.textContent;
      commitCell(td);
      closeChips();
    });
  }

  // 표를 다시 그릴 때마다 붙이면 같은 처리기가 쌓인다 — 한 번만 단다
  if (!window._gridChipsBound) {
    window._gridChipsBound = true;
    document.addEventListener("mousedown", function (e) {
      if (!e.target.closest(".grid-chips") && !e.target.closest("td[contenteditable]")) closeChips();
    });
  }

  // 마지막에 넣은 값 기억 — 거주지처럼 하루 종일 같은 값을 다시 치지 않게
  var MEM = "grid_sticky_" + (opts.memoryKey || "기본");
  function readMem() {
    try { return JSON.parse(localStorage.getItem(MEM) || "{}"); } catch (e) { return {}; }
  }
  function writeMem(key, val) {
    try {
      var m = readMem();
      if (val) m[key] = val; else delete m[key];
      localStorage.setItem(MEM, JSON.stringify(m));
    } catch (e) { /* 사파리 비공개 모드 */ }
  }

  function cellAt(ri, ci) {
    return root.querySelector('tr[data-ri="' + ri + '"] td[data-ci="' + ci + '"]');
  }

  function commitCell(td) {
    var ri = Number(td.parentNode.dataset.ri), ci = Number(td.dataset.ci);
    var r = rows[ri], key = cols[ci].key;
    var v = td.innerText.replace(/\n/g, " ").trim();
    if (cols[ci].date) { v = normDate(v); td.innerText = v; }   // 눈앞에서 바로 고쳐 보여준다
    if (String(r[key] == null ? "" : r[key]) === v) return;
    r[key] = v;
    if (cols[ci].sticky) writeMem(key, v);
    if (r._id != null) dirty.add(r._id); else added.add(r);
    td.parentNode.classList.add("dirty");
  }

  function addRow(preset) {
    var mem = readMem();
    var r = Object.assign({}, opts.fixed || {}, preset || {});
    cols.forEach(function (c) { if (r[c.key] == null && c.sticky && mem[c.key]) r[c.key] = mem[c.key]; });
    cols.forEach(function (c) { if (r[c.key] == null) r[c.key] = ""; });
    rows.push(r);
    added.add(r);
    render();
    var td = cellAt(rows.length - 1, 0);
    if (td) td.focus();
    return r;
  }

  root.addEventListener("focusout", function (e) {
    var td = e.target.closest && e.target.closest("td[contenteditable]");
    if (td) commitCell(td);
  });

  // 칸에 들어오면 칩을 띄운다. 눌러서 들어오든 Tab으로 넘어오든 같게 동작해야 한다.
  function chipsFor(target) {
    var td = target.closest && target.closest("td[contenteditable]");
    if (!td) { closeChips(); return; }
    var col = cols[Number(td.dataset.ci)];
    if (col && col.opts) openChips(td, col); else closeChips();
  }
  root.addEventListener("focusin", function (e) { chipsFor(e.target); });
  root.addEventListener("click", function (e) { chipsFor(e.target); });

  root.addEventListener("keydown", function (e) {
    var td = e.target.closest && e.target.closest("td[contenteditable]");
    if (!td) return;
    var ri = Number(td.parentNode.dataset.ri), ci = Number(td.dataset.ci);
    if (e.key === "Enter") {
      e.preventDefault();
      commitCell(td);
      if (ri === rows.length - 1) { addRow(); return; }
      var below = cellAt(ri + 1, ci);
      if (below) below.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      var next = cellAt(ri + (e.key === "ArrowDown" ? 1 : -1), ci);
      if (next) { e.preventDefault(); commitCell(td); next.focus(); }
    }
  });

  // 엑셀 붙여넣기: 탭·줄바꿈으로 갈라 현재 셀부터 채운다. 줄이 모자라면 만든다.
  // 남의 행(읽기 전용)은 건너뛴다 — 저장 시 403이 나고 내 행까지 못 저장하게 된다.
  root.addEventListener("paste", function (e) {
    var td = e.target.closest && e.target.closest("td[contenteditable]");
    if (!td) return;
    var text = (e.clipboardData || window.clipboardData).getData("text");
    if (!text || (text.indexOf("\t") < 0 && text.indexOf("\n") < 0)) return;   // 단일 값은 기본 동작
    e.preventDefault();
    var startRi = Number(td.parentNode.dataset.ri), startCi = Number(td.dataset.ci);
    var lines = text.replace(/\r/g, "").split("\n").filter(function (l, i, a) { return !(i === a.length - 1 && l === ""); });
    lines.forEach(function (line, li) {
      var ri = startRi + li;
      if (ri >= rows.length) addRow();
      var r = rows[ri];
      if (opts.canEditRow && !opts.canEditRow(r)) return;   // 남의 행은 건드리지 않는다
      line.split("\t").forEach(function (val, vi) {
        var c = cols[startCi + vi];
        if (!c) return;
        r[c.key] = c.date ? normDate(val) : val.trim();
      });
      if (r._id != null) dirty.add(r._id); else added.add(r);
    });
    render();
    var back = cellAt(startRi, startCi);
    if (back) back.focus();
  });

  root.addEventListener("click", function (e) {
    var del = e.target.closest && e.target.closest(".row-del");
    if (!del) return;
    var ri = Number(del.parentNode.dataset.ri);
    var r = rows[ri];
    if (r._id != null) {
      if (!opts.onDeleteRow) return;
      if (!confirm("이 줄을 삭제할까?")) return;
      opts.onDeleteRow(r, function () { rows.splice(ri, 1); dirty.delete(r._id); render(); });
    } else {
      rows.splice(ri, 1); added.delete(r); render();
    }
  });

  render();

  return {
    addRow: addRow,
    // 저장 직전 호출 — 편집 중인 셀(포커스가 안 빠진 칸)을 반영한다
    commitActive: function () {
      var td = document.activeElement;
      if (td && td.matches && td.matches("td[contenteditable]") && root.contains(td)) commitCell(td);
    },
    rows: function () { return rows; },
    newRows: function () { return rows.filter(function (r) { return added.has(r); }); },
    dirtyRows: function () { return rows.filter(function (r) { return r._id != null && dirty.has(r._id); }); },
    hasChanges: function () { return added.size > 0 || dirty.size > 0; },
    markSaved: function () { dirty.clear(); added.clear(); render(); },
    // 한 줄만 저장됐다고 표시한다. 여러 건을 따로 보낼 때 일부만 성공하면
    // 성공한 줄을 남겨둬야 다시 눌렀을 때 중복 저장되지 않는다.
    markRowSaved: function (r, id) {
      if (id != null && r._id == null) r._id = id;
      added.delete(r);
      if (r._id != null) dirty.delete(r._id);
      render();
    }
  };
}
