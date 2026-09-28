// 서비스 워커 — 일일보고 알림만 맡는다. 화면·파일을 가로채지 않는다(fetch 처리 없음 → 캐시 사고 없음).
// 서버는 본문 없이 「울려라」만 보낸다(server/push.js). 문구는 여기서 시각으로 고른다 — 8시 알림은 재촉.
self.addEventListener("push", function (e) {
  var late = new Date().getHours() >= 20;
  e.waitUntil(self.registration.showNotification("하랑지점 일일보고", {
    body: late ? "내일 일일보고가 아직 없습니다. 지금 적어 주세요." : "내일 일일보고를 적을 시간입니다.",
    icon: "assets/icon-192.png",
    tag: "daily-report",          // 6시 알림을 안 봤으면 8시 알림이 그 자리를 덮는다
    renotify: true
  }));
});

// 누르면 일일보고 화면으로 — 열린 창이 있으면 그 창을 새로 읽어 저녁 기준(내일 보고)으로 연다
self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var url = new URL("./?quick=report&n=" + Date.now() + "#att", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
    var c = list[0];
    if (!c || !("navigate" in c)) return self.clients.openWindow(url);
    // 이 워커가 맡지 않은 창은 navigate가 거절된다 — 그때는 새 창으로
    return c.navigate(url).then(function (w) { return (w || c).focus(); }, function () { return self.clients.openWindow(url); });
  }));
});
