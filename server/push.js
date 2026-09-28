// 웹 푸시 — 일일보고 알림 (2026-09-28 사용자: 저녁 6시·8시, 폰 알림 허용).
// 외부 패키지 없이 node:crypto로 VAPID 서명만 한다. 본문은 보내지 않는다 —
// 본문이 없으면 암호화(aes128gcm)가 필요 없고, 문구는 서비스 워커(web/sw.js)가 정한다.
import { generateKeyPairSync, createPrivateKey, sign } from "node:crypto";
import { getSetting, setSetting } from "./db.js";

const b64u = buf => Buffer.from(buf).toString("base64url");

// 키는 처음 한 번 만들어 settings에 둔다. 바꾸면 모든 구독이 무효가 되니 다시 만들지 않는다.
export function vapidKeys(db) {
  let jwk = getSetting(db, "vapid_jwk");
  if (!jwk) {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    jwk = JSON.stringify(privateKey.export({ format: "jwk" }));
    setSetting(db, "vapid_jwk", jwk);
  }
  const j = JSON.parse(jwk);
  const pub = b64u(Buffer.concat([Buffer.from([4]), Buffer.from(j.x, "base64url"), Buffer.from(j.y, "base64url")]));
  return { pub, key: createPrivateKey({ key: j, format: "jwk" }) };
}

// 받는 곳은 알려진 푸시 서버만 — 아무 주소나 받으면 우리 서버가 남의 주소로 요청을 쏘는 통로가 된다
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
export function okEndpoint(u) {
  try {
    const url = new URL(u);
    if (process.env.PUSH_ALLOW_LOCAL === "1" && url.hostname === "127.0.0.1") return true;   // 시험용
    return url.protocol === "https:" && PUSH_HOSTS.some(r => r.test(url.hostname));
  } catch { return false; }
}

// 한 구독에 알림 한 번. 돌려주는 값은 HTTP 상태 — 404·410이면 구독이 죽은 것이다.
export async function sendPush(endpoint, keys) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: process.env.PUSH_SUB || "https://api.insurguard.life/branch/" }));
  const sig = sign("sha256", Buffer.from(head + "." + body), { key: keys.key, dsaEncoding: "ieee-p1363" });
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { TTL: "3600", Urgency: "high", Authorization: `vapid t=${head}.${body}.${b64u(sig)}, k=${keys.pub}` },
    body: new Uint8Array(0),
    signal: AbortSignal.timeout(10000)
  });
  return r.status;
}
