<p align="center">
  <img src="villife.ico" alt="Villife" width="88">
</p>

<h1 align="center">Villife</h1>

<p align="center">
  A free music player for Windows, macOS, Linux and the browser. Search, local library, playlists, queue and playback history — in English and Russian.
</p>

<p align="center">
  <a href="https://villife.hs.vc/"><img src="https://img.shields.io/badge/Visit%20Villife-website-24252a?style=for-the-badge" alt="Website"></a>
  <a href="https://web.villife.hs.vc/"><img src="https://img.shields.io/badge/Web%20player-Open-24252a?style=for-the-badge" alt="Web player"></a>
<a href="https://boosty.to/whata/donate"><img src="https://img.shields.io/badge/Boosty-Donate-F15A2C?style=for-the-badge&amp;logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyMzUuNiAyOTIuMiI%2BPHBhdGggZmlsbD0iI0ZGRkZGRiIgZD0iTTQ0LjMsMTY0LjVMNzYuOSw1MS42SDEyN2wtMTAuMSwzNWMtMC4xLDAuMi0wLjIsMC40LTAuMywwLjZMOTAsMTc5LjZoMjQuOGMtMTAuNCwyNS45LTE4LjUsNDYuMi0yNC4zLDYwLjkgYy00NS44LTAuNS01OC42LTMzLjMtNDcuNC03Mi4xIE05MC43LDI0MC42bDYwLjQtODYuOWgtMjUuNmwyMi4zLTU1LjdjMzguMiw0LDU2LjIsMzQuMSw0NS42LDcwLjUgYy0xMS4zLDM5LjEtNTcuMSw3Mi4xLTEwMS43LDcyLjFDOTEuMywyNDAuNiw5MSwyNDAuNiw5MC43LDI0MC42eiIvPjwvc3ZnPg%3D%3D" alt="Donate on Boosty"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux%20%C2%B7%20Web-1687d9?style=flat-square" alt="Platforms">
  <img src="https://img.shields.io/badge/Interface-EN%20%7C%20RU-6956a5?style=flat-square" alt="EN and RU">
  <img src="https://img.shields.io/badge/Status-In%20development-e39a31?style=flat-square" alt="In development">
</p>

---

## What it does

Villife is a player first: find a track, throw it into the queue, save it, and keep listening. Shuffle, repeat, crossfade and a sleep timer are there too.

There are profiles now — an avatar, a few listening stats, public playlists and the artists you follow. Sign in with Microsoft on the site, link the desktop app with a one-time code, and the avatar follows you between the site, the web player and the app.

`web.villife.hs.vc` is the same app in the browser. You can play tracks straight from the website now.

On Windows it hooks into media keys, the tray and Discord Rich Presence. On macOS and Linux the interface runs in an Electron shell.

Search and audio go through a Cloudflare Worker. Covers and audio chunks are cached in R2, so playback keeps working even if the music CDN is unreachable from your network.

## Web

- **Website** — https://villife.hs.vc/
- **Web player** — https://web.villife.hs.vc/

The web player opens with a Spotify-style sign-in screen. After signing in it shows the same player interface as the desktop app.

## Install

**Windows** — `VillifeSetup.exe` from the [releases page](https://github.com/whatawhere/villife/releases/latest), or the zip: extract the whole folder, `src` and `villife.ico` have to stay next to `Villife.exe`. The first run downloads the browser engine, so internet is needed once, after that the library and settings live locally in the WebView2 profile.

**macOS** — `Villife-macOS-arm64.dmg` or `Villife-macOS-x64.dmg`, zip archives are there too.

**Linux** — `Villife-linux-x64.AppImage` or `Villife-linux-amd64.deb`.

## Build

You need Windows, MSBuild (Visual Studio or the Build Tools), the .NET Framework 4.6.2 Developer Pack, and the WebView2 assemblies in the `webview2` folder at the project root — that folder is not in git.

```powershell
msbuild .\src\Villife.csproj /t:Build /p:Configuration=Release
```

You get `Villife.exe` in the project root.

## Layout

```text
.
├── src/                    Windows app: window, local server, C# logic
│   ├── villife.cs          window, local HTTP server, provider calls
│   ├── discord.cs          Discord Rich Presence
│   ├── index.html          interface markup
│   ├── css/app.css         styles
│   └── js/app.js           player logic
├── desktop/                Electron shell for macOS and Linux builds
├── activate/               device activation page
├── signin/                 Microsoft sign-in page
├── css/ js/ fonts/         assets served by the web root
├── search-worker.js        Cloudflare Worker (search, stream and image proxy)
├── .github/workflows/      release pipeline
├── installer.iss           Inno Setup script
├── villife.ico             icon
└── README.md
```

## About the data

Library, favorites, history and settings stay in the local WebView2 profile (or browser storage in the web player). No account is required to listen. The profile is local as well; Microsoft OAuth is only used to identify the account, and the desktop app receives it through a one-time activation code.

## Questions

**Do I need a Spotify account?** No. Spotify is used only for public track metadata, not for playback.

**Where is my library?** In the local WebView2 profile. There is a JSON export if you want a portable copy.

**Why does the web player cache audio?** The CDN that hosts the audio may be unavailable in some networks. The Worker fetches it once and stores it in R2, after which playback comes from the Worker's own domain.

---

<p align="center">
  <a href="https://villife.hs.vc/">villife.hs.vc</a>
</p>
