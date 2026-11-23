const VLF_API = "https://villife-catalog.telesamafia.workers.dev";

function vlfDeviceName() {
  const agent = navigator.userAgent;
  if (/Windows NT 10/.test(agent)) return "Windows 11";
  if (/Windows/.test(agent)) return "Windows";
  if (/Macintosh/.test(agent)) return "macOS";
  if (/Android/.test(agent)) return "Android";
  if (/iPhone|iPad/.test(agent)) return "iOS";
  if (/Linux/.test(agent)) return "Linux";
  return "Браузер";
}

function vlfStoreToken(token) {
  localStorage.setItem("villife_token", token);
}

function vlfMessage(id, text) {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}

async function vlfJson(path, options) {
  const response = await fetch(VLF_API + path, Object.assign({ headers: { "Content-Type": "application/json" } }, options));
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
        const result = await vlfJson("/auth/email/request", {
          method: "POST",
          body: JSON.stringify({ email })
        });
        vlfMessage("vlf-email-status", result.devCode
          ? "Демо-код: " + result.devCode
          : "Код отправлен на " + email);
        document.getElementById("vlf-email-code").focus();
      } else {
        const result = await vlfJson("/auth/email/verify", {
          method: "POST",
          body: JSON.stringify({ email, code })
        });
        vlfStoreToken(result.token);
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
      image.innerHTML = '<img src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' + encodeURIComponent(target) + '" alt="QR code">';
      vlfMessage("vlf-qr-status", "Отсканируй QR в приложении Villife на телефоне");
      timer = setInterval(async () => {
        try {
          const state = await vlfJson("/auth/qr/status?session=" + encodeURIComponent(session.session));
          if (state.status === "approved" && state.token) {
            clearInterval(timer);
            vlfStoreToken(state.token);
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

vlfInitEmail();
vlfInitQr();
