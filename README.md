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
  <a href="https://boosty.to/whata/donate"><img src="https://img.shields.io/badge/Boosty-Donate-F15A2C?style=for-the-badge&amp;logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyMzUuNiAyOTIuMiI%2BPGRlZnM%2BPGxpbmVhckdyYWRpZW50IGlkPSJnIiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSIgeDE9IjE0NS4wNzc3IiB5MT0iNzYuMTQ4IiB4Mj0iODAuNTg2OCIgeTI9IjI5Ni4wNzg1Ij48c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiNFRjc4MjkiLz48c3RvcCBvZmZzZXQ9Ii4wNTE5IiBzdG9wLWNvbG9yPSIjRjA3NTI5Ii8%2BPHN0b3Agb2Zmc2V0PSIuMzU1MSIgc3RvcC1jb2xvcj0iI0YwNjcyQiIvPjxzdG9wIG9mZnNldD0iLjY2NzMiIHN0b3AtY29sb3I9IiNGMTVFMkMiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiNGMTVBMkMiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48cGF0aCBmaWxsPSJ1cmwoI2cpIiBkPSJNNDQuMywxNjQuNUw3Ni45LDUxLjZIMTI3bC0xMC4xLDM1Yy0wLjEsMC4yLTAuMiwwLjQtMC4zLDAuNkw5MCwxNzkuNmgyNC44Yy0xMC40LDI1LjktMTguNSw0Ni4yLTI0LjMsNjAuOSBjLTQ1LjgtMC41LTU4LjYtMzMuMy00Ny40LTcyLjEgTTkwLjcsMjQwLjZsNjAuNC04Ni45aC0yNS42bDIyLjMtNTUuN2MzOC4yLDQsNTYuMiwzNC4xLDQ1LjYsNzAuNSBjLTExLjMsMzkuMS01Ny4xLDcyLjEtMTAxLjcsNzIuMUM5MS4zLDI0MC42LDkxLDI0MC42LDkwLjcsMjQwLjZ6Ii8%2BPC9zdmc%2B" alt="Donate on Boosty"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux%20%C2%B7%20Web-1687d9?style=flat-square" alt="Platforms">
  <img src="https://img.shields.io/badge/Interface-EN%20%7C%20RU-6956a5?style=flat-square" alt="EN and RU">
  <img src="https://img.shields.io/badge/Status-In%20development-e39a31?style=flat-square" alt="In development">
</p>

---

## What it does

Find a track, add it to the queue or save it to your library — and just listen. Shuffle, repeat, crossfade and a sleep timer are there too.

There are profiles now: set an avatar, see your listening stats, build public playlists and follow artists. Sign in with Microsoft, a code from your email, a password, or a QR code confirmed on your phone.

The player also runs in the browser at `web.villife.hs.vc` — nothing to install.

On Windows you get media keys, a tray icon and Discord Rich Presence so friends can see what is playing. There are builds for macOS and Linux too.

Audio and covers are cached on an intermediate server, so tracks keep loading and playing even when the original source is slow or blocked in your network.

## Links

- **Website** — https://villife.hs.vc/
- **Web player** — https://web.villife.hs.vc/

## Install

**Windows** — download `VillifeSetup.exe` from the [releases page](https://github.com/whatawhere/villife/releases/latest), or grab the zip. If you use the zip, extract the whole archive: the `src` folder and `villife.ico` must stay next to `Villife.exe`. On first launch the app downloads the browser engine; after that your library and settings stay on your computer.

**macOS** — `Villife-macOS-arm64.dmg` for Apple Silicon (M1–M4) or `Villife-macOS-x64.dmg` for Intel. Zip archives are available too.

**Linux** — `Villife-linux-x64.AppImage` or `Villife-linux-amd64.deb`.

## Build

You need Windows, MSBuild (Visual Studio or Build Tools), the .NET Framework 4.6.2 Developer Pack, and the WebView2 assemblies in the `webview2` folder at the project root (that folder is not in git).

```powershell
msbuild .\src\Villife.csproj /t:Build /p:Configuration=Release
```

You will get `Villife.exe` in the project root.

## Layout

```text
.
├── docs/                   GitHub Pages site (villife.hs.vc and web.villife.hs.vc)
│   ├── activate/ signin/ qr/ status/   site pages
│   ├── css/ js/ db/ assets/ fonts/    styles, scripts and database schema
│   ├── worker/             Cloudflare Workers (search, audio, catalog and accounts)
│   ├── desktop/ scripts/   macOS and Linux build shell and helpers
│   └── index.html          web player entry point
├── src/                    Windows app: window, local server, C# logic
│   ├── villife.cs          window and main logic
│   ├── discord.cs          Discord Rich Presence
│   ├── index.html          player interface
│   └── css/app.css         styles
├── .github/workflows/      release pipeline
├── runtime/                local build artifacts (not in git)
├── README.md
└── villife.ico
```

## About the data

Saved tracks, favourites, history and settings live on your device (or in browser storage for the web player). You do not need an account just to listen.

Passwords are hashed on the server, and the desktop app is linked to your account with a one-time code.

## Questions

**Do I need an account?** No. You can listen and build a library without signing in. An account is only needed for cloud sync or Studio.

**Where is my music?** In the app storage on your computer. There is an export button in settings so you can save the whole collection to one file and move it to another PC.

**Why does audio go through an extra server?** In some networks the original source is slow or blocked. The intermediate server saves the track once and then serves it to you quickly.

---

<p align="center">
  <a href="https://villife.hs.vc/">villife.hs.vc</a>
</p>
