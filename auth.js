const VILLIFE_CLIENT_ID = "c68beaeb-2b07-4a86-a56f-f40f5a319657";
const VILLIFE_TENANT = "e2b609df-e29d-42c3-84f2-75e4a9390e74";
const VILLIFE_REDIRECT = location.origin + "/signin/";
const VILLIFE_AUTHORITY = "https://login.microsoftonline.com/" + VILLIFE_TENANT + "/oauth2/v2.0";

function villifeBase64url(bytes) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function villifeRandom(length) {
  const values = new Uint8Array(length);
  crypto.getRandomValues(values);
  return villifeBase64url(values);
}

function villifeDecodeJwt(token) {
  const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = part + "=".repeat((4 - part.length % 4) % 4);
  return JSON.parse(atob(padded));
}

async function villifeMicrosoftSignIn() {
  const verifier = villifeRandom(48);
  const state = villifeRandom(24);
  const nonce = villifeRandom(24);
  sessionStorage.setItem("villife_pkce", verifier);
  sessionStorage.setItem("villife_state", state);
  sessionStorage.setItem("villife_nonce", nonce);
  localStorage.setItem("villife_pkce", verifier);
  localStorage.setItem("villife_state", state);
  localStorage.setItem("villife_nonce", nonce);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const params = new URLSearchParams({
    client_id: VILLIFE_CLIENT_ID,
    response_type: "code",
    redirect_uri: VILLIFE_REDIRECT,
    scope: "openid profile email User.Read",
    state: state,
    nonce: nonce,
    code_challenge: villifeBase64url(new Uint8Array(digest)),
    code_challenge_method: "S256"
  });
  location.href = VILLIFE_AUTHORITY + "/authorize?" + params.toString();
}

async function villifeMicrosoftCallback() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  const state = params.get("state");
  const error = params.get("error");
  if (error) {
    history.replaceState(null, "", location.pathname);
    return { error: error };
  }
  if (!code) return null;
  history.replaceState(null, "", location.pathname);
  const savedState = sessionStorage.getItem("villife_state") || localStorage.getItem("villife_state");
  if (savedState !== state) return { error: "state_mismatch" };
  const verifier = sessionStorage.getItem("villife_pkce") || localStorage.getItem("villife_pkce");
  const nonce = sessionStorage.getItem("villife_nonce") || localStorage.getItem("villife_nonce");
  const body = new URLSearchParams({
    client_id: VILLIFE_CLIENT_ID,
    grant_type: "authorization_code",
    code: code,
    redirect_uri: VILLIFE_REDIRECT,
    code_verifier: verifier
  });
  try {
    const response = await fetch(VILLIFE_AUTHORITY + "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });
    if (!response.ok) return { error: "token_failed" };
    const tokens = await response.json();
    const claims = villifeDecodeJwt(tokens.id_token);
    if (claims.aud !== VILLIFE_CLIENT_ID || claims.nonce !== nonce) return { error: "invalid_token" };
    const profile = {
      name: claims.name || claims.preferred_username || "Microsoft user",
      username: claims.preferred_username || claims.email || "",
      email: claims.email || claims.preferred_username || "",
      birthDate: "",
      provider: "microsoft",
      method: "microsoft",
      photo: ""
    };
    if (tokens.access_token) {
      try {
        const photo = await fetch("https://graph.microsoft.com/v1.0/me/photo/$value", {
          headers: { Authorization: "Bearer " + tokens.access_token }
        });
        if (photo.ok) {
          const blob = await photo.blob();
          profile.photo = await new Promise(resolve => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => resolve("");
            reader.readAsDataURL(blob);
          });
        }
      } catch (failure) {
        profile.photo = "";
      }
    }
    localStorage.setItem("villife_signup", JSON.stringify(profile));
    localStorage.setItem("villife_session", "active");
    sessionStorage.removeItem("villife_pkce");
    sessionStorage.removeItem("villife_state");
    sessionStorage.removeItem("villife_nonce");
    localStorage.removeItem("villife_pkce");
    localStorage.removeItem("villife_state");
    localStorage.removeItem("villife_nonce");
    return profile;
  } catch (failure) {
    return { error: "token_failed" };
  }
}
