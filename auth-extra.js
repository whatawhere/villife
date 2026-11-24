const VLF_API = "https://villife-catalog.telesamafia.workers.dev";
let vlfCsrf = null;

function vlfDeviceName() {
  const agent = navigator.userAgent;
  if (/Windows NT 10/.test(agent)) return "Windows 11";
  if (/Windows/.test(agent)) return "Windows";
  if (/Macintosh/.test(agent)) return "macOS";
  if (/Android/.test(agent)) return "Android";
  if (/iPhone|iPad/.test(agent)) return "iOS";
  if (/Linux/.test(agent)) return "Linux";
  return "Browser";
}

function vlfMessage(id, text) {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}

async function vlfCsrfToken() {
  if (vlfCsrf) return vlfCsrf;
  const response = await fetch(VLF_API + "/auth/csrf", { credentials: "include" });
  const data = await response.json();
  vlfCsrf = data.token;
  return vlfCsrf;
}

async function vlfJson(path, options) {
  const method = options && options.method ? options.method.toUpperCase() : "GET";
  const headers = Object.assign({ "Content-Type": "application/json" }, options && options.headers);
  if (method !== "GET" && method !== "HEAD") headers["X-CSRF-Token"] = await vlfCsrfToken();
  const response = await fetch(VLF_API + path, Object.assign({ credentials: "include", headers }, options, { headers }));
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || ("HTTP " + response.status));
  return data;
}

function vlfInitEmail() {
  const toggle = document.getElementById("vlf-email-toggle");
  const form = document.getElementById("vlf-email-form");
  if (!toggle || !form) return;
  toggle.addEventListener("click", () => {
    form.hidden = !form.hidden;
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const email = document.getElementById("vlf-email-address").value.trim();
    const code = document.getElementById("vlf-email-code").value.trim();
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      if (!code) {
        await vlfJson("/auth/email/request", {
          method: "POST",
          body: JSON.stringify({ email })
        });
        vlfMessage("vlf-email-status", "Код отправлен на " + email);
        document.getElementById("vlf-email-code").focus();
      } else {
        await vlfJson("/auth/email/verify", {
          method: "POST",
          body: JSON.stringify({ email, code })
        });
        vlfMessage("vlf-email-status", "Вход выполнен");
        location.href = "/profile/";
      }
    } catch (error) {
      vlfMessage("vlf-email-status", "Ошибка: " + error.message);
    } finally {
      button.disabled = false;
    }
  });
}

function vlfInitQr() {
  const toggle = document.getElementById("vlf-qr-toggle");
  const panel = document.getElementById("vlf-qr-panel");
  if (!toggle || !panel) return;
  let timer = null;
  toggle.addEventListener("click", async () => {
    panel.hidden = !panel.hidden;
    if (panel.hidden || timer) return;
    try {
      const session = await vlfJson("/auth/qr/create", {
        method: "POST",
        body: JSON.stringify({ device: vlfDeviceName() })
      });
      const target = location.origin + "/qr/?session=" + encodeURIComponent(session.session) + "&device=" + encodeURIComponent(session.device);
      const image = document.getElementById("vlf-qr-image");
      const link = document.createElement("img");
      link.src = "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=" + encodeURIComponent(target);
      link.alt = "QR code";
      image.innerHTML = "";
      image.appendChild(link);
      vlfMessage("vlf-qr-status", "Отсканируй QR в приложении Villife на телефоне");
      timer = setInterval(async () => {
        try {
          const state = await vlfJson("/auth/qr/status?session=" + encodeURIComponent(session.session));
          if (state.status === "approved") {
            clearInterval(timer);
            vlfMessage("vlf-qr-status", "Вход подтверждён");
            location.href = "/profile/";
          } else if (state.status === "denied") {
            clearInterval(timer);
            vlfMessage("vlf-qr-status", "Вход отклонён");
          } else if (state.status === "expired") {
            clearInterval(timer);
            vlfMessage("vlf-qr-status", "Код устарел — открой заново");
          }
        } catch (error) {
          clearInterval(timer);
          vlfMessage("vlf-qr-status", "Ошибка: " + error.message);
        }
      }, 1000);
    } catch (error) {
      vlfMessage("vlf-qr-status", "Ошибка: " + error.message);
    }
  });
}

function vlfInitPassword() {
  const toggle = document.getElementById("vlf-pass-toggle");
  const form = document.getElementById("vlf-pass-form");
  if (!toggle || !form) return;
  toggle.addEventListener("click", () => {
    form.hidden = !form.hidden;
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const email = document.getElementById("vlf-pass-email").value.trim();
    const password = document.getElementById("vlf-pass-password").value;
    try {
      await vlfJson("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password })
      });
      vlfMessage("vlf-pass-status", "Вход выполнен");
      location.href = "/profile/";
    } catch (error) {
      vlfMessage("vlf-pass-status", "Ошибка: " + error.message);
    }
  });
}

vlfInitEmail();
vlfInitPassword();
vlfInitQr();
