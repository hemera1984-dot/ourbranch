// 엑셀형 그리드 — 이 프로젝트의 존재 이유는 "작성이 아주아주 편할 것"이다.
// 셀 클릭 편집, Tab/Enter 이동(마지막 줄에서 Enter면 새 줄), 엑셀 여러 줄 붙여넣기.
// 프레임워크 없음. 데이터는 rows 배열을 직접 들고 있고 저장은 호출부가 한다.

"use strict";

function makeGrid(root, opts) {
  // opts: { cols: [{key, label, num?, width?}], rows: [{...,_id?}], canEditRow(row) -> bool,
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

  function render() {
    var h = ['<div class="grid-wrap"><table class="grid"><thead><tr>'];
    cols.forEach(function (c) { h.push("<th" + (c.width ? ' style="min-width:' + c.width + 'px"' : "") + ">" + esc(c.label) + "</th>"); });
    h.push("<th></th></tr></thead><tbody>");
    rows.forEach(function (r, ri) {
      var editable = opts.canEditRow ? opts.canEditRow(r) : true;
      h.push('<tr data-ri="' + ri + '"' + (dirty.has(r._id) || added.has(r) ? ' class="dirty"' : "") + ">");
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

  function cellAt(ri, ci) {
    return root.querySelector('tr[data-ri="' + ri + '"] td[data-ci="' + ci + '"]');
  }

  function commitCell(td) {
    var ri = Number(td.parentNode.dataset.ri), ci = Number(td.dataset.ci);
    var r = rows[ri], key = cols[ci].key;
    var v = td.innerText.replace(/\n/g, " ").trim();
    if (String(r[key] == null ? "" : r[key]) === v) return;
    r[key] = v;
    if (r._id != null) dirty.add(r._id); else added.add(r);
    td.parentNode.classList.add("dirty");
  }

  function addRow(preset) {
    var r = Object.assign({}, opts.fixed || {}, preset || {});
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
        r[c.key] = val.trim();
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
    markSaved: function () { dirty.clear(); added.clear(); render(); }
  };
}
